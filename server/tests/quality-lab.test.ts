import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { QualityRunService } from '../services/quality-run.service';
import { QualityLabService } from '../services/quality-lab.service';
import { QUALITY_BASELINE_VERSION_ID } from '../eval/quality-baseline';
import { SessionRepo } from '../db/repos/session.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { MessageRole } from '../types/domain';

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

async function main(): Promise<void> {
  testDefaultPolicyAndBuiltinDatasetBootstrap();
  testCustomDatasetVersionLifecycle();
  testPolicyHistoryRollbackAndMessageSnapshot();
  await testPersistedRunLifecycle();
  console.log('quality lab tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
