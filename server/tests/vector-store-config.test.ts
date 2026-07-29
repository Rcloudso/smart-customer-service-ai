import assert from 'node:assert/strict';
import { resolveVectorStoreEnvironment } from '../config';

function testVectorStoreEnvironmentDefaultsToMemory(): void {
  const resolved = resolveVectorStoreEnvironment({});
  assert.equal(resolved.provider, 'memory');
  assert.equal(resolved.qdrantUrl, '');
  assert.equal(resolved.collectionPrefix, 'resolveweave_knowledge');
  assert.equal(resolved.collectionAlias, 'resolveweave_knowledge_active');
  assert.equal(resolved.timeoutMs, 5_000);
  assert.equal(resolved.traceRetentionDays, 30);
}

function testQdrantEnvironmentIsExplicitAndBounded(): void {
  assert.throws(
    () => resolveVectorStoreEnvironment({ VECTOR_STORE_PROVIDER: 'qdrant' }),
    /QDRANT_URL is required/,
  );
  assert.throws(
    () => resolveVectorStoreEnvironment({
      VECTOR_STORE_PROVIDER: 'qdrant',
      QDRANT_URL: 'file:///tmp/qdrant',
    }),
    /http or https/,
  );

  const resolved = resolveVectorStoreEnvironment({
    VECTOR_STORE_PROVIDER: 'qdrant',
    QDRANT_URL: ' https://qdrant.example.test ',
    QDRANT_API_KEY: 'secret',
    QDRANT_TIMEOUT_MS: '9000',
    RETRIEVAL_TRACE_RETENTION_DAYS: '45',
  });
  assert.equal(resolved.provider, 'qdrant');
  assert.equal(resolved.qdrantUrl, 'https://qdrant.example.test');
  assert.equal(resolved.timeoutMs, 9_000);
  assert.equal(resolved.traceRetentionDays, 45);
}

testVectorStoreEnvironmentDefaultsToMemory();
testQdrantEnvironmentIsExplicitAndBounded();
console.log('vector store config tests passed');
