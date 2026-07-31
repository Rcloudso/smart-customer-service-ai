import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QdrantClient, withHeaders } from '@qdrant/js-client-rest';
import { createQdrantVectorStore } from '../ai/qdrant-vector-store';
import { InMemoryVectorStore, type VectorStore } from '../ai/vector-store';

const qdrantUrl = process.env.QDRANT_URL?.trim() ?? '';
if (!qdrantUrl) {
  throw new Error('QDRANT_URL is required for the Qdrant integration test');
}

const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const firstCollection = `resolveweave_ci_a_${suffix}`;
const secondCollection = `resolveweave_ci_b_${suffix}`;
const alias = `resolveweave_ci_active_${suffix}`;
const client = new QdrantClient({
  url: qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY || undefined,
  timeout: 10_000,
  checkCompatibility: false,
});
const traced = <T>(operation: () => Promise<T>): Promise<T> => withHeaders(
  { 'x-request-id': `qdrant-ci-${randomUUID()}` },
  operation,
);

async function main(): Promise<void> {
  try {
    await traced(() => client.createCollection(firstCollection, {
      vectors: { size: 4, distance: 'Cosine' },
    }));
    await traced(() => client.createCollection(secondCollection, {
      vectors: { size: 4, distance: 'Cosine' },
    }));
    await traced(() => client.updateCollectionAliases({
      actions: [{
        create_alias: {
          alias_name: alias,
          collection_name: firstCollection,
        },
      }],
    }));

    const store = createQdrantVectorStore({
      url: qdrantUrl,
      apiKey: process.env.QDRANT_API_KEY || '',
      timeoutMs: 10_000,
      collectionAlias: alias,
    });
    await store.upsertBatch([
      {
        id: 'faq:integration-faq',
        knowledgeType: 'faq',
        revision: 'faq-revision-1',
        embeddingProfile: 'integration-v1',
        embedding: [1, 0, 0, 0],
      },
      {
        id: 'document:integration-document',
        knowledgeType: 'document',
        revision: 'document-revision-1',
        embeddingProfile: 'integration-v1',
        embedding: [0, 1, 0, 0],
      },
    ], 'qdrant-integration-upsert');
    const memoryStore = new InMemoryVectorStore();
    await memoryStore.upsertBatch([
      {
        id: 'faq:integration-faq',
        knowledgeType: 'faq',
        revision: 'faq-revision-1',
        embeddingProfile: 'integration-v1',
        embedding: [1, 0, 0, 0],
      },
      {
        id: 'document:integration-document',
        knowledgeType: 'document',
        revision: 'document-revision-1',
        embeddingProfile: 'integration-v1',
        embedding: [0, 1, 0, 0],
      },
    ]);

    const faqResults = await store.search([1, 0, 0, 0], {
      limit: 5,
      knowledgeTypes: ['faq'],
      traceId: 'qdrant-integration-search',
    });
    assert.deepEqual(faqResults.map((result) => result.id), ['faq:integration-faq']);
    assert.ok(faqResults.every((result) => result.knowledgeType === 'faq'));
    const memoryMetrics = await measureBackend(memoryStore);
    const qdrantMetrics = await measureBackend(store);
    assert.equal(memoryMetrics.recallAt1, 1);
    assert.equal(qdrantMetrics.recallAt1, 1);
    console.log(JSON.stringify({
      benchmark: 'qdrant-integration-two-case',
      memory: memoryMetrics,
      qdrant: qdrantMetrics,
      p95LatencyDeltaPercent: Number(
        (((qdrantMetrics.p95LatencyMs / memoryMetrics.p95LatencyMs) - 1) * 100).toFixed(2),
      ),
    }));

    const stats = await store.stats('qdrant-integration-stats');
    assert.equal(stats.indexedCount, 2);
    assert.equal(stats.embeddingDimensions, 4);
    assert.equal((await store.health()).status, 'healthy');

    const payload = await traced(() => client.scroll(alias, {
      limit: 10,
      with_payload: true,
      with_vector: false,
    }));
    assert.equal(payload.points.length, 2);
    for (const point of payload.points) {
      assert.deepEqual(
        Object.keys(point.payload ?? {}).sort(),
        ['embeddingProfile', 'knowledgeType', 'pointKey', 'revision'],
      );
    }

    await traced(() => client.updateCollectionAliases({
      actions: [
        { delete_alias: { alias_name: alias } },
        {
          create_alias: {
            alias_name: alias,
            collection_name: secondCollection,
          },
        },
      ],
    }));
    const aliases = await traced(() => client.getAliases());
    assert.equal(
      aliases.aliases.find((entry) => entry.alias_name === alias)?.collection_name,
      secondCollection,
    );

    await store.upsertBatch([{
      id: 'faq:after-alias-switch',
      knowledgeType: 'faq',
      revision: 'faq-revision-2',
      embeddingProfile: 'integration-v1',
      embedding: [0, 0, 1, 0],
    }], 'qdrant-integration-alias-switch');
    assert.equal((await traced(() => client.getCollection(secondCollection))).points_count, 1);
    assert.equal((await traced(() => client.getCollection(firstCollection))).points_count, 2);

    await store.delete(['faq:after-alias-switch'], 'qdrant-integration-delete');
    assert.equal((await store.stats()).indexedCount, 0);
    console.log('Qdrant 1.18 integration tests passed');
  } finally {
    await deleteAliasIfPresent();
    await Promise.allSettled([
      traced(() => client.deleteCollection(firstCollection)),
      traced(() => client.deleteCollection(secondCollection)),
    ]);
  }
}

async function measureBackend(store: VectorStore): Promise<{
  recallAt1: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}> {
  const cases = [
    { embedding: [1, 0, 0, 0], expectedId: 'faq:integration-faq' },
    { embedding: [0, 1, 0, 0], expectedId: 'document:integration-document' },
  ];
  const latencies: number[] = [];
  let hits = 0;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    for (const item of cases) {
      const startedAt = performance.now();
      const results = await store.search(item.embedding, {
        limit: 1,
        traceId: `qdrant-integration-benchmark-${iteration}`,
      });
      latencies.push(performance.now() - startedAt);
      if (results[0]?.id === item.expectedId) hits += 1;
    }
  }
  latencies.sort((left, right) => left - right);
  return {
    recallAt1: hits / (cases.length * 10),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

function percentile(values: number[], ratio: number): number {
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return Number(values[index].toFixed(3));
}

async function deleteAliasIfPresent(): Promise<void> {
  try {
    const aliases = await traced(() => client.getAliases());
    if (!aliases.aliases.some((entry) => entry.alias_name === alias)) return;
    await traced(() => client.updateCollectionAliases({
      actions: [{ delete_alias: { alias_name: alias } }],
    }));
  } catch {
    // Preserve the original integration failure; unique collections are CI-only.
  }
}

main().catch((error) => {
  console.error({
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorCode: typeof error === 'object' && error
      ? String((error as { code?: unknown }).code ?? 'qdrant_integration_failed')
      : 'qdrant_integration_failed',
  });
  process.exit(1);
});
