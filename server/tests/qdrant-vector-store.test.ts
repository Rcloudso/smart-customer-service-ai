import assert from 'node:assert/strict';
import {
  QdrantVectorStore,
  type QdrantClientLike,
  type QdrantHeaderRunner,
} from '../ai/qdrant-vector-store';

async function testQdrantVectorStoreMapsSafeRecordsAndTraceHeaders(): Promise<void> {
  const calls: Array<{ method: string; collection?: string; payload?: unknown }> = [];
  const tracedHeaders: Array<Record<string, string>> = [];
  const client: QdrantClientLike = {
    async upsert(collection, payload) {
      calls.push({ method: 'upsert', collection, payload });
      return { status: 'completed' };
    },
    async delete(collection, payload) {
      calls.push({ method: 'delete', collection, payload });
      return { status: 'completed' };
    },
    async query(collection, payload) {
      calls.push({ method: 'query', collection, payload });
      return {
        points: [{
          id: '5f851638-3602-5728-a7f1-5334e2e32ae2',
          score: 0.91,
          payload: {
            pointKey: 'faq:refund',
            knowledgeType: 'faq',
            revision: 'faq-v1',
            embeddingProfile: 'test-profile',
          },
        }],
      };
    },
    async getCollection(collection) {
      calls.push({ method: 'getCollection', collection });
      return {
        status: 'green',
        points_count: 1,
        config: {
          params: {
            vectors: { size: 2, distance: 'Cosine' },
          },
        },
      };
    },
  };
  const runWithHeaders: QdrantHeaderRunner = async (headers, operation) => {
    tracedHeaders.push(headers);
    return operation();
  };
  const store = new QdrantVectorStore({
    client,
    collectionAlias: 'resolveweave_knowledge_active',
    runWithHeaders,
  });

  await store.upsertBatch([{
    id: 'faq:refund',
    knowledgeType: 'faq',
    revision: 'faq-v1',
    embeddingProfile: 'test-profile',
    embedding: [1, 0],
  }], 'trace-upsert');

  const upsert = calls.find((call) => call.method === 'upsert');
  assert.equal(upsert?.collection, 'resolveweave_knowledge_active');
  const points = (upsert?.payload as { points: Array<Record<string, unknown>> }).points;
  assert.match(String(points[0].id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(points[0].payload, {
    pointKey: 'faq:refund',
    knowledgeType: 'faq',
    revision: 'faq-v1',
    embeddingProfile: 'test-profile',
  });
  assert.equal(JSON.stringify(points[0]).includes('refund answer'), false);

  const matches = await store.search([1, 0], {
    limit: 3,
    knowledgeTypes: ['faq'],
    traceId: 'trace-search',
  });
  assert.deepEqual(matches, [{
    id: 'faq:refund',
    knowledgeType: 'faq',
    revision: 'faq-v1',
    embeddingProfile: 'test-profile',
    score: 0.91,
  }]);
  const query = calls.find((call) => call.method === 'query');
  assert.deepEqual(
    (query?.payload as { filter: unknown }).filter,
    { must: [{ key: 'knowledgeType', match: { any: ['faq'] } }] },
  );

  const stats = await store.stats('trace-stats');
  assert.equal(stats.indexedCount, 1);
  assert.equal(stats.embeddingDimensions, 2);
  const health = await store.health('trace-health');
  assert.equal(health.backend, 'qdrant');
  assert.equal(health.status, 'healthy');

  assert.deepEqual(tracedHeaders, [
    { 'x-request-id': 'trace-upsert' },
    { 'x-request-id': 'trace-search' },
    { 'x-request-id': 'trace-stats' },
    { 'x-request-id': 'trace-health' },
  ]);
}

testQdrantVectorStoreMapsSafeRecordsAndTraceHeaders()
  .then(() => console.log('qdrant vector store tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
