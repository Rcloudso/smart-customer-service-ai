import assert from 'node:assert/strict';
import { InMemoryVectorStore } from '../ai/vector-store';

async function testAsyncInMemoryVectorStoreContract(): Promise<void> {
  const store = new InMemoryVectorStore();

  await store.upsertBatch([
    {
      id: 'faq:refund',
      knowledgeType: 'faq',
      revision: 'faq-v1',
      embeddingProfile: 'test-profile',
      embedding: [1, 0],
    },
    {
      id: 'document:policy',
      knowledgeType: 'document',
      revision: 'document-v1',
      embeddingProfile: 'test-profile',
      embedding: [0.8, 0.2],
    },
  ]);

  const faqMatches = await store.search([1, 0], {
    limit: 5,
    knowledgeTypes: ['faq'],
    traceId: 'trace-vector-store-contract',
  });

  assert.deepEqual(faqMatches.map((match) => match.id), ['faq:refund']);
  assert.equal(faqMatches[0].knowledgeType, 'faq');
  assert.equal(faqMatches[0].revision, 'faq-v1');
  assert.equal(faqMatches[0].score, 1);

  const stats = await store.stats();
  assert.equal(stats.indexedCount, 2);
  assert.equal(stats.embeddingDimensions, 2);

  const health = await store.health('trace-vector-store-health');
  assert.equal(health.backend, 'memory');
  assert.equal(health.status, 'healthy');

  await store.delete(['faq:refund']);
  assert.equal((await store.stats()).indexedCount, 1);
}

testAsyncInMemoryVectorStoreContract()
  .then(() => console.log('vector store tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
