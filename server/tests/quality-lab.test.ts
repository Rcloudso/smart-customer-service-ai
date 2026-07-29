import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import {
  QualityRunService,
  qualityFixtureCandidates,
} from '../services/quality-run.service';
import { QualityLabService } from '../services/quality-lab.service';
import {
  QUALITY_BASELINE_CASES,
  QUALITY_BASELINE_VERSION_ID,
} from '../eval/quality-baseline';
import { SessionRepo } from '../db/repos/session.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { MessageRole } from '../types/domain';
import { NotFoundError } from '../utils/errors';
import { FaqRepo } from '../db/repos/faq.repo';
import { IntentCategory } from '../types/domain';
import type { RetrievalResult } from '../types/ai';
import type { RetrievalIndexJob } from '../types/retrieval-ops';

function testDefaultPolicyAndBuiltinDatasetBootstrap(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();

    assert.deepEqual(qualityLab.getCurrentPolicy().config, {
      directFaqThreshold: 0.8,
      generationEvidenceThreshold: 0.55,
      sourceDiversityRatio: 0.6,
      rerankerMode: 'none',
    });

    const datasets = qualityLab.listDatasets();
    assert.equal(datasets.length, 1);
    assert.equal(datasets[0].origin, 'builtin');
    assert.equal(datasets[0].status, 'published');
    assert.equal(datasets[0].targetKind, 'fixture');
    assert.ok(datasets[0].caseCount >= 12);

    qualityLab.bootstrap();
    assert.equal(qualityLab.listDatasets().length, 1, 'bootstrap must be idempotent');
  } finally {
    db.close();
  }
}

function testBuiltinDatasetCannotBeRewrittenInPlace(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const before = qualityLab.listCases(QUALITY_BASELINE_VERSION_ID);
    db.prepare(
      'UPDATE quality_dataset_versions SET content_hash = ? WHERE id = ?',
    ).run('unexpected-hash', QUALITY_BASELINE_VERSION_ID);

    assert.throws(() => qualityLab.bootstrap(), /immutable version ID/i);
    assert.deepEqual(qualityLab.listCases(QUALITY_BASELINE_VERSION_ID), before);
  } finally {
    db.close();
  }
}

function testCustomDatasetVersionLifecycle(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db, () => new Date('2026-07-23T00:00:00.000Z'));
    qualityLab.bootstrap();

    const draft = qualityLab.createDataset({
      name: '售后真实问题',
      description: '管理员维护的当前知识评测集',
      createdBy: 'admin',
    });
    assert.equal(draft.origin, 'custom');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.targetKind, 'current');

    const createdCase = qualityLab.saveCase(draft.id, {
      query: '如何申请退款？',
      expectedAnswerMode: 'direct_faq',
      expectedGroundingStatus: 'sufficient',
      expectedSources: [{ knowledgeType: 'faq', knowledgeId: 'faq-1' }],
      language: 'zh',
      tags: ['refund'],
    });
    assert.equal(createdCase.query, '如何申请退款？');
    assert.equal(qualityLab.listCases(draft.id).length, 1);
    assert.throws(() => qualityLab.saveCase(draft.id, {
      id: crypto.randomUUID(),
      query: '不存在的用例',
      expectedAnswerMode: 'direct_faq',
      expectedGroundingStatus: 'sufficient',
      expectedSources: [{ knowledgeType: 'faq', knowledgeId: 'faq-1' }],
      language: 'zh',
      tags: [],
    }), NotFoundError);

    const published = qualityLab.publishVersion(draft.id, 'admin');
    assert.equal(published.status, 'published');
    assert.ok(published.contentHash);
    assert.throws(
      () => qualityLab.saveCase(published.id, {
        id: createdCase.id,
        query: '修改后的问题',
        expectedAnswerMode: 'direct_faq',
        expectedGroundingStatus: 'sufficient',
        expectedSources: [{ knowledgeType: 'faq', knowledgeId: 'faq-1' }],
        language: 'zh',
        tags: [],
      }),
      /published/i,
    );

    const nextDraft = qualityLab.deriveVersion(published.id, 'admin');
    assert.equal(nextDraft.version, 2);
    assert.equal(nextDraft.status, 'draft');
    assert.equal(qualityLab.listCases(nextDraft.id).length, 1);
    assert.notEqual(qualityLab.listCases(nextDraft.id)[0].id, createdCase.id);

    assert.throws(() => qualityLab.importCases(nextDraft.id, [{
      query: 'invalid',
      expectedAnswerMode: 'direct_faq',
      expectedGroundingStatus: 'insufficient',
      expectedSources: [],
      language: 'en',
      tags: [],
    }]), /must expect refusal/i);
    assert.equal(
      qualityLab.listCases(nextDraft.id).length,
      1,
      'invalid import must not partially replace the draft',
    );
  } finally {
    db.close();
  }
}

async function testPersistedRunLifecycle(): Promise<void> {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const runs = new QualityRunService(db, {
      qualityLab,
      searchCurrent: async () => [],
      now: () => new Date('2026-07-23T01:00:00.000Z'),
      autoDrain: false,
    });

    const run = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID],
      policies: [qualityLab.getCurrentPolicy().config],
      createdBy: 'admin',
    });
    assert.equal(run.status, 'queued');

    await runs.processNext();
    const completed = runs.getRun(run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, completed.totalCases);
    assert.equal(completed.totalCases, 12);
    assert.equal(completed.candidates.length, 1);
    assert.equal(completed.candidates[0].metrics.unsafeAnswerCount, 0);

    const blocked = runs.checkPromotion(run.id, completed.candidates[0].key);
    assert.equal(blocked.eligible, false);
    assert.ok(blocked.reasons.includes('current_knowledge_dataset_required'));

    const queued = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID],
      policies: [],
      createdBy: 'admin',
    });
    assert.equal(runs.cancelRun(queued.id).status, 'cancelled');
    const interrupted = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID],
      policies: [],
      createdBy: 'admin',
    });
    runs.start();
    assert.equal(runs.getRun(interrupted.id).status, 'interrupted');
  } finally {
    db.close();
  }
}

async function testCoverageCannotBeAggregatedAcrossSmallVersions(): Promise<void> {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const versionIds = [1, 2].map((suffix) => {
      const draft = qualityLab.createDataset({
        name: `Small ${suffix}`,
        createdBy: 'admin',
      });
      qualityLab.importCases(draft.id, [
        ...Array.from({ length: 3 }, (_, index) => ({
          query: `answerable-${suffix}-${index}`,
          expectedAnswerMode: 'grounded_generation' as const,
          expectedGroundingStatus: 'sufficient' as const,
          expectedSources: [{ knowledgeType: 'faq' as const, knowledgeId: `faq-${index}` }],
          language: 'en' as const,
          tags: [],
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          query: `insufficient-${suffix}-${index}`,
          expectedAnswerMode: 'refusal' as const,
          expectedGroundingStatus: 'insufficient' as const,
          expectedSources: [],
          language: 'en' as const,
          tags: [],
        })),
        {
          query: `high-risk-${suffix}`,
          expectedAnswerMode: 'refusal' as const,
          expectedGroundingStatus: 'high_risk' as const,
          expectedSources: [],
          language: 'en' as const,
          tags: [],
        },
      ]);
      return qualityLab.publishVersion(draft.id, 'admin').id;
    });
    const runs = new QualityRunService(db, {
      qualityLab,
      searchCurrentBatch: async (queries) => queries.map(() => []),
      autoDrain: false,
    });
    const run = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID, ...versionIds],
      policies: [],
      createdBy: 'admin',
    });
    await runs.processNext();
    const completed = runs.getRun(run.id);
    const gate = runs.checkPromotion(run.id, completed.candidates[0].key);
    assert.ok(gate.reasons.includes('current_knowledge_coverage_insufficient'));
  } finally {
    db.close();
  }
}

function publishCompleteCurrentVersion(qualityLab: QualityLabService): string {
  const draft = qualityLab.createDataset({
    name: 'Current knowledge regression set',
    createdBy: 'admin',
  });
  qualityLab.importCases(draft.id, QUALITY_BASELINE_CASES.map(
    ({ id: _id, ...testCase }) => testCase,
  ));
  return qualityLab.publishVersion(draft.id, 'admin').id;
}

async function testSuccessfulActivationAndFingerprintStaleness(): Promise<void> {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const currentVersionId = publishCompleteCurrentVersion(qualityLab);
    const caseByQuery = new Map(QUALITY_BASELINE_CASES.map((testCase) => [
      testCase.query,
      {
        ...testCase,
        versionId: currentVersionId,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    ]));
    const runs = new QualityRunService(db, {
      qualityLab,
      searchCurrentBatch: async (queries) => queries.map((query) => (
        qualityFixtureCandidates(caseByQuery.get(query)!)
      )),
      autoDrain: false,
    });
    const run = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID, currentVersionId],
      policies: [],
      createdBy: 'admin',
    });
    await runs.processNext();
    const completed = runs.getRun(run.id);
    const candidate = completed.candidates[0];
    assert.equal(runs.checkPromotion(run.id, candidate.key).eligible, true);
    const activated = runs.activateCandidate({
      runId: run.id,
      candidateKey: candidate.key,
      expectedCurrentPolicyId: completed.activePolicyId,
      actor: 'admin',
    });
    assert.notEqual(activated.id, completed.activePolicyId);
    assert.throws(() => runs.activateCandidate({
      runId: run.id,
      candidateKey: candidate.key,
      expectedCurrentPolicyId: completed.activePolicyId,
      actor: 'admin',
    }), /gate failed/i);

    const freshRun = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID, currentVersionId],
      policies: [],
      createdBy: 'admin',
    });
    await runs.processNext();
    new FaqRepo(db).create({
      question: 'New active knowledge',
      answer: 'Changes the fingerprint.',
      category: IntentCategory.GENERAL,
      keywords: [],
    });
    assert.equal(runs.getRun(freshRun.id).status, 'stale');
  } finally {
    db.close();
  }
}

async function testMemoryAndQdrantBackendsShareOneQualityInput(): Promise<void> {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const currentVersionId = publishCompleteCurrentVersion(qualityLab);
    const caseByQuery = new Map(QUALITY_BASELINE_CASES.map((testCase) => [
      testCase.query,
      {
        ...testCase,
        versionId: currentVersionId,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    ]));
    let fingerprint = '';
    const embeddingBatches: number[][][] = [];
    const targets: string[] = [];
    const runs = new QualityRunService(db, {
      qualityLab,
      autoDrain: false,
      getIndexJob: () => ({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'ready',
        collection: 'quality_collection',
        embeddingProfile: 'combined:test',
        vectorDimension: 2,
        knowledgeFingerprint: fingerprint,
        expectedCount: 1,
        completedCount: 1,
        checkpoint: 1,
        previousCollection: null,
        failureCode: null,
        createdBy: 'admin',
        createdAt: '2026-07-23T00:00:00.000Z',
        startedAt: '2026-07-23T00:00:00.000Z',
        readyAt: '2026-07-23T00:00:00.000Z',
        activatedAt: null,
        rolledBackAt: null,
        updatedAt: '2026-07-23T00:00:00.000Z',
      } satisfies RetrievalIndexJob),
      searchBackendBatch: async (target, queries, embeddings) => {
        targets.push(target.provider);
        embeddingBatches.push(embeddings);
        return queries.map((query) => qualityFixtureCandidates(caseByQuery.get(query)!));
      },
    });
    fingerprint = runs.knowledgeFingerprint();
    const run = runs.createRun({
      datasetVersionIds: [QUALITY_BASELINE_VERSION_ID, currentVersionId],
      policies: [],
      backendTargets: [
        { provider: 'memory' },
        { provider: 'qdrant', indexJobId: '11111111-1111-4111-8111-111111111111' },
      ],
      createdBy: 'admin',
    });

    await runs.processNext();
    const completed = runs.getRun(run.id);
    assert.deepEqual(targets, ['memory', 'qdrant']);
    assert.equal(embeddingBatches[0], embeddingBatches[1]);
    assert.equal(completed.candidates.length, 2);
    assert.ok(completed.candidates.some((candidate) => candidate.key.startsWith('memory:')));
    const qdrantCandidate = completed.candidates.find(
      (candidate) => candidate.backendTarget.provider === 'qdrant',
    );
    assert.ok(qdrantCandidate?.key.includes('qdrant:11111111-1111-4111-8111-111111111111:'));
    assert.equal(
      runs.checkBackendActivation(run.id, qdrantCandidate!.key).eligible,
      true,
    );
  } finally {
    db.close();
  }
}

async function testRunningCancellationIsPersisted(): Promise<void> {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const currentVersionId = publishCompleteCurrentVersion(qualityLab);
    let resolveSearch!: (value: RetrievalResult[][]) => void;
    const runs = new QualityRunService(db, {
      qualityLab,
      searchCurrentBatch: async () => new Promise<RetrievalResult[][]>((resolve) => {
        resolveSearch = resolve;
      }),
      autoDrain: false,
    });
    const run = runs.createRun({
      datasetVersionIds: [currentVersionId],
      policies: [],
      createdBy: 'admin',
    });
    const processing = runs.processNext();
    assert.equal(runs.getRun(run.id).status, 'running');
    runs.cancelRun(run.id);
    resolveSearch(QUALITY_BASELINE_CASES.map(() => []));
    await processing;
    assert.equal(runs.getRun(run.id).status, 'cancelled');
  } finally {
    db.close();
  }
}

function testPolicyHistoryRollbackAndMessageSnapshot(): void {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const qualityLab = new QualityLabService(db);
    qualityLab.bootstrap();
    const initial = qualityLab.getCurrentPolicy();
    const activated = qualityLab.activatePolicy({
      expectedCurrentPolicyId: initial.id,
      config: { ...initial.config, rerankerMode: 'local_overlap_v1' },
      sourceRunId: 'run-1',
      sourceCandidateKey: 'candidate-1',
      actor: 'admin',
    });
    assert.notEqual(activated.id, initial.id);
    assert.throws(() => qualityLab.rollbackPolicy({
      targetPolicyId: initial.id,
      expectedCurrentPolicyId: initial.id,
      actor: 'admin',
    }), /changed/i);
    const rolledBack = qualityLab.rollbackPolicy({
      targetPolicyId: initial.id,
      expectedCurrentPolicyId: activated.id,
      actor: 'admin',
    });
    assert.deepEqual(rolledBack.config, initial.config);
    assert.equal(qualityLab.listPolicyEvents().length, 2);

    const session = new SessionRepo(db).create('quality-user');
    const message = new MessageRepo(db).create({
      sessionId: session.id,
      role: MessageRole.ASSISTANT,
      content: 'answer',
      retrievalPolicyId: activated.id,
    });
    assert.equal(message.retrievalPolicyId, activated.id);
    assert.equal(new MessageRepo(db).findById(message.id)?.retrievalPolicyId, activated.id);
  } finally {
    db.close();
  }
}

function testBuiltinRetrievalDoesNotReadExpectedSources(): void {
  const candidates = qualityFixtureCandidates({
    id: 'independence-check',
    versionId: QUALITY_BASELINE_VERSION_ID,
    query: '如何申请退款？',
    expectedAnswerMode: 'direct_faq',
    expectedGroundingStatus: 'sufficient',
    expectedSources: [{ knowledgeType: 'faq', knowledgeId: 'deliberately-wrong' }],
    language: 'zh',
    tags: [],
    createdAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(candidates[0].knowledgeId, 'faq-refund-apply');
}

async function main(): Promise<void> {
  testDefaultPolicyAndBuiltinDatasetBootstrap();
  testBuiltinDatasetCannotBeRewrittenInPlace();
  testCustomDatasetVersionLifecycle();
  testPolicyHistoryRollbackAndMessageSnapshot();
  testBuiltinRetrievalDoesNotReadExpectedSources();
  await testPersistedRunLifecycle();
  await testCoverageCannotBeAggregatedAcrossSmallVersions();
    await testSuccessfulActivationAndFingerprintStaleness();
    await testMemoryAndQdrantBackendsShareOneQualityInput();
  await testRunningCancellationIsPersisted();
  console.log('quality lab tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
