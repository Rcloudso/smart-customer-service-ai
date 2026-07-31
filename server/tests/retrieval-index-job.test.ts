import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { RetrievalIndexJobService } from '../services/retrieval-index-job.service';
import { IntentCategory } from '../types/domain';
import type {
  QdrantCollectionControl,
  RetrievalIndexVectorWriter,
} from '../services/retrieval-index-job.service';

async function testIndexJobBuildsIdempotentlyAndDetectsStaleKnowledge(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db);
  const faqRepo = new FaqRepo(db);
  faqRepo.create({
    question: '退款期限',
    answer: '七天内可退款',
    category: IntentCategory.REFUND,
    keywords: ['退款'],
    embedding: [1, 0],
    embeddingProfile: 'test-profile',
  });
  const collections = new Map<string, { dimensions: number; count: number }>();
  let aliasCollection: string | null = null;
  const control: QdrantCollectionControl = {
    async createCollection(name, dimensions) {
      if (collections.has(name)) return false;
      collections.set(name, { dimensions, count: 0 });
      return true;
    },
    async collectionInfo(name) {
      return collections.get(name) ?? null;
    },
    async currentAliasCollection() {
      return aliasCollection;
    },
    async switchAlias(next, expected) {
      assert.equal(aliasCollection, expected);
      aliasCollection = next;
    },
  };
  const writerFactory = (collection: string): RetrievalIndexVectorWriter => ({
    async upsert(records) {
      const current = collections.get(collection);
      assert.ok(current);
      current.count += records.length;
    },
  });
  const service = new RetrievalIndexJobService(db, {
    control,
    writerFactory,
    collectionPrefix: 'test_knowledge',
    autoDrain: false,
    activationGate: () => ({
      eligible: true,
      warnings: [],
      reasons: [],
      qualityRunId: 'quality-run',
      candidateKey: 'quality-candidate',
    }),
  });

  const created = await service.createJob({ createdBy: 'admin' });
  const duplicate = await service.createJob({ createdBy: 'admin' });
  assert.equal(duplicate.id, created.id, 'same fingerprint should reuse the build');
  assert.equal(created.status, 'queued');

  await service.processNext();
  const ready = service.getJob(created.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.expectedCount, 1);
  assert.equal(ready.completedCount, 1);
  assert.equal(ready.vectorDimension, 2);

  const firstActive = await service.activate({
    id: ready.id,
    expectedCurrentCollection: null,
    confirmLatencyWarning: false,
  });
  assert.equal(firstActive.status, 'active');
  assert.equal(aliasCollection, ready.collection);

  const secondId = '22222222-2222-4222-8222-222222222222';
  const secondCollection = 'test_knowledge_second';
  collections.set(secondCollection, { dimensions: 2, count: 1 });
  db.prepare(`
    INSERT INTO retrieval_index_jobs (
      id, status, collection_name, embedding_profile, vector_dimension,
      knowledge_fingerprint, expected_count, completed_count, batch_checkpoint,
      previous_collection, failure_code, created_by, created_at, started_at,
      ready_at, activated_at, rolled_back_at, updated_at
    )
    SELECT ?, 'ready', ?, embedding_profile, vector_dimension,
           knowledge_fingerprint, expected_count, completed_count, batch_checkpoint,
           NULL, NULL, created_by, created_at, started_at, ready_at, NULL, NULL, updated_at
    FROM retrieval_index_jobs WHERE id = ?
  `).run(secondId, secondCollection, ready.id);
  const secondActive = await service.activate({
    id: secondId,
    expectedCurrentCollection: ready.collection,
    confirmLatencyWarning: false,
  });
  assert.equal(secondActive.previousCollection, ready.collection);
  assert.equal(aliasCollection, secondCollection);
  db.exec(`
    CREATE TRIGGER fail_rollback_persistence
    BEFORE UPDATE ON retrieval_index_jobs
    WHEN OLD.id = '${secondId}' AND NEW.status = 'rolled_back'
    BEGIN
      SELECT RAISE(ABORT, 'simulated rollback persistence failure');
    END
  `);
  await assert.rejects(
    () => service.rollback({
      id: secondId,
      expectedCurrentCollection: secondCollection,
    }),
    /simulated rollback persistence failure/,
  );
  assert.equal(aliasCollection, ready.collection);
  assert.equal(service.getJob(secondId).status, 'active');
  db.exec('DROP TRIGGER fail_rollback_persistence');
  const rolledBack = await service.rollback({
    id: secondId,
    expectedCurrentCollection: secondCollection,
  });
  assert.equal(rolledBack.id, ready.id);
  assert.equal(rolledBack.status, 'active');
  assert.equal(aliasCollection, ready.collection);

  const staleReadyId = '33333333-3333-4333-8333-333333333333';
  db.prepare(`
    INSERT INTO retrieval_index_jobs (
      id, status, collection_name, embedding_profile, vector_dimension,
      knowledge_fingerprint, expected_count, completed_count, batch_checkpoint,
      previous_collection, failure_code, created_by, created_at, started_at,
      ready_at, activated_at, rolled_back_at, updated_at
    )
    SELECT ?, 'ready', 'test_knowledge_stale', embedding_profile, vector_dimension,
           knowledge_fingerprint, expected_count, completed_count, batch_checkpoint,
           NULL, NULL, created_by, created_at, started_at, ready_at, NULL, NULL, updated_at
    FROM retrieval_index_jobs WHERE id = ?
  `).run(staleReadyId, ready.id);
  const currentFaq = faqRepo.listAllActive()[0];
  faqRepo.update(currentFaq.id, { answer: '退款政策已更新' });
  assert.equal(service.getJob(staleReadyId).status, 'stale');
  db.close();
}

async function testInterruptedJobResumesFromCheckpoint(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const faqRepo = new FaqRepo(db);
  for (let index = 0; index < 205; index += 1) {
    faqRepo.create({
      question: `policy ${index.toString().padStart(3, '0')}`,
      answer: `answer ${index}`,
      category: IntentCategory.GENERAL,
      keywords: [],
      embedding: index % 2 === 0 ? [1, 0] : [0, 1],
      embeddingProfile: 'test-profile',
    });
  }
  const collections = new Map<string, { dimensions: number; count: number }>();
  const resumedBatchSizes: number[] = [];
  const service = new RetrievalIndexJobService(db, {
    autoDrain: false,
    collectionPrefix: 'resume_test',
    control: {
      async createCollection(name, dimensions) {
        collections.set(name, { dimensions, count: 0 });
        return true;
      },
      async collectionInfo(name) {
        return collections.get(name) ?? null;
      },
      async currentAliasCollection() {
        return null;
      },
      async switchAlias() {},
    },
    writerFactory: (collection) => ({
      async upsert(records) {
        resumedBatchSizes.push(records.length);
        collections.get(collection)!.count += records.length;
      },
    }),
  });
  const job = await service.createJob({ createdBy: 'admin' });
  collections.set(job.collection, { dimensions: 2, count: 100 });
  db.prepare(`
    UPDATE retrieval_index_jobs
    SET status = 'running', batch_checkpoint = 100, completed_count = 100
    WHERE id = ?
  `).run(job.id);

  service.start();
  assert.equal(service.getJob(job.id).status, 'interrupted');
  await service.processNext();
  const resumed = service.getJob(job.id);
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.checkpoint, 205);
  assert.equal(resumed.completedCount, 205);
  assert.deepEqual(resumedBatchSizes, [100, 5]);
  db.close();
}

async function testReadyValidationUsesSafeFailureCodes(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  new FaqRepo(db).create({
    question: 'shipping policy',
    answer: 'ships tomorrow',
    category: IntentCategory.ORDER,
    keywords: [],
    embedding: [1, 0],
    embeddingProfile: 'test-profile',
  });
  const collections = new Map<string, { dimensions: number; count: number }>();
  const service = new RetrievalIndexJobService(db, {
    autoDrain: false,
    collectionPrefix: 'validation_test',
    control: {
      async createCollection(name, dimensions) {
        collections.set(name, { dimensions, count: 0 });
        return true;
      },
      async collectionInfo(name) {
        return collections.get(name) ?? null;
      },
      async currentAliasCollection() {
        return null;
      },
      async switchAlias() {},
    },
    writerFactory: () => ({
      async upsert() {
        // Deliberately leave the remote count unchanged.
      },
    }),
  });
  const job = await service.createJob({ createdBy: 'admin' });
  await service.processNext();
  const failed = service.getJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'qdrant_point_count_mismatch');
  assert.equal(JSON.stringify(failed).includes('remote count unchanged'), false);
  db.close();
}

async function testActivationRecoversAfterAliasSwitchPersistenceFailure(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  new FaqRepo(db).create({
    question: 'recovery policy',
    answer: 'recovery answer',
    category: IntentCategory.GENERAL,
    keywords: [],
    embedding: [1, 0],
    embeddingProfile: 'test-profile',
  });
  const collections = new Map<string, { dimensions: number; count: number }>();
  let aliasCollection: string | null = null;
  const service = new RetrievalIndexJobService(db, {
    autoDrain: false,
    collectionPrefix: 'recovery_test',
    activationGate: () => ({
      eligible: true,
      warnings: [],
      reasons: [],
      qualityRunId: 'quality-run',
      candidateKey: 'quality-candidate',
    }),
    control: {
      async createCollection(name, dimensions) {
        collections.set(name, { dimensions, count: 0 });
        return true;
      },
      async collectionInfo(name) {
        return collections.get(name) ?? null;
      },
      async currentAliasCollection() {
        return aliasCollection;
      },
      async switchAlias(next, expected) {
        assert.equal(aliasCollection, expected);
        aliasCollection = next;
      },
    },
    writerFactory: (collection) => ({
      async upsert(records) {
        collections.get(collection)!.count += records.length;
      },
    }),
  });
  const job = await service.createJob({ createdBy: 'admin' });
  await service.processNext();
  db.exec(`
    CREATE TRIGGER fail_activation_persistence
    BEFORE UPDATE ON retrieval_index_jobs
    WHEN NEW.status = 'active'
    BEGIN
      SELECT RAISE(ABORT, 'simulated persistence failure');
    END
  `);
  await assert.rejects(
    () => service.activate({
      id: job.id,
      expectedCurrentCollection: null,
      confirmLatencyWarning: false,
    }),
    /simulated persistence failure/,
  );
  assert.equal(aliasCollection, job.collection);
  assert.equal(service.getJob(job.id).status, 'ready');
  const faqRepo = new FaqRepo(db);
  const faq = faqRepo.listAllActive()[0];
  faqRepo.update(faq.id, { answer: 'knowledge changed after alias switch' });
  assert.equal(
    service.getJob(job.id).status,
    'ready',
    'pending activation must not be made stale before reconciliation',
  );
  db.exec('DROP TRIGGER fail_activation_persistence');

  const recovered = await service.activate({
    id: job.id,
    expectedCurrentCollection: null,
    confirmLatencyWarning: false,
  });
  assert.equal(recovered.status, 'active');
  assert.equal(aliasCollection, job.collection);
  db.close();
}

async function testActivationIntentFinishesAfterPreSwitchFailure(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  const faqRepo = new FaqRepo(db);
  faqRepo.create({
    question: 'intent policy',
    answer: 'intent answer',
    category: IntentCategory.GENERAL,
    keywords: [],
    embedding: [1, 0],
    embeddingProfile: 'test-profile',
  });
  const collections = new Map<string, { dimensions: number; count: number }>();
  let aliasCollection: string | null = null;
  let failSwitch = true;
  const service = new RetrievalIndexJobService(db, {
    autoDrain: false,
    collectionPrefix: 'intent_test',
    activationGate: () => ({
      eligible: true,
      warnings: [],
      reasons: [],
      qualityRunId: 'quality-run',
      candidateKey: 'quality-candidate',
    }),
    control: {
      async createCollection(name, dimensions) {
        collections.set(name, { dimensions, count: 0 });
        return true;
      },
      async collectionInfo(name) {
        return collections.get(name) ?? null;
      },
      async currentAliasCollection() {
        return aliasCollection;
      },
      async switchAlias(next, expected) {
        assert.equal(aliasCollection, expected);
        if (failSwitch) throw new Error('simulated pre-switch failure');
        aliasCollection = next;
      },
    },
    writerFactory: (collection) => ({
      async upsert(records) {
        collections.get(collection)!.count += records.length;
      },
    }),
  });
  const job = await service.createJob({ createdBy: 'admin' });
  await service.processNext();
  await assert.rejects(
    () => service.activate({
      id: job.id,
      expectedCurrentCollection: null,
      confirmLatencyWarning: false,
    }),
    /simulated pre-switch failure/,
  );
  assert.equal(aliasCollection, null);
  failSwitch = false;
  const faq = faqRepo.listAllActive()[0];
  faqRepo.update(faq.id, { answer: 'changed while intent was pending' });

  const recovered = await service.activate({
    id: job.id,
    expectedCurrentCollection: null,
    confirmLatencyWarning: false,
  });
  assert.equal(recovered.status, 'active');
  assert.equal(aliasCollection, job.collection);
  db.close();
}

Promise.all([
  testIndexJobBuildsIdempotentlyAndDetectsStaleKnowledge(),
  testInterruptedJobResumesFromCheckpoint(),
  testReadyValidationUsesSafeFailureCodes(),
  testActivationRecoversAfterAliasSwitchPersistenceFailure(),
  testActivationIntentFinishesAfterPreSwitchFailure(),
])
  .then(() => console.log('retrieval index job tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
