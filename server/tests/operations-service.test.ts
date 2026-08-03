import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';
import { MessageRepo } from '../db/repos/message.repo';
import { QualityRunRepo } from '../db/repos/quality-run.repo';
import { RetrievalIndexJobRepo } from '../db/repos/retrieval-index-job.repo';
import { RetrievalTraceRepo } from '../db/repos/retrieval-trace.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { OperationsService } from '../services/operations.service';
import { RetrievalTraceCollector } from '../services/retrieval-trace-collector';
import { MessageRole } from '../types/domain';

async function testBoundedOverviewAndRecoveryMapping(): Promise<void> {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    initSchema(db);
    const documentRepo = new DocumentRepo(db);
    const document = documentRepo.createPending({
      id: '11111111-1111-4111-8111-111111111111',
      fileName: 'failed.md',
      storagePath: 'failed.md',
      format: 'md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      uploadedBy: 'test',
    });
    documentRepo.markFailed(document.id, 'document_parse_failed');

    db.prepare(`
      INSERT INTO retrieval_policies (
        id, version_number, direct_faq_threshold, generation_evidence_threshold,
        source_diversity_ratio, reranker_mode, source_run_id,
        source_candidate_key, created_by, created_at
      ) VALUES ('policy-test', 1, 0.9, 0.6, 0, 'none', NULL, NULL, 'test', ?)
    `).run('2026-08-03T00:00:00.000Z');
    const qualityRepo = new QualityRunRepo(db);
    const quality = qualityRepo.create({
      datasetVersionIds: ['version-test'],
      policies: [{
        directFaqThreshold: 0.9,
        generationEvidenceThreshold: 0.6,
        sourceDiversityRatio: 0,
        rerankerMode: 'none',
      }],
      backendTargets: [{ provider: 'memory' }],
      totalCases: 1,
      knowledgeFingerprint: null,
      activePolicyId: 'policy-test',
      createdBy: 'test',
      now: '2026-08-03T00:00:00.000Z',
    });
    qualityRepo.markFailed(quality.id, 'quality_failed', '2026-08-03T00:01:00.000Z');

    const indexRepo = new RetrievalIndexJobRepo(db);
    const index = indexRepo.create({
      collection: 'failed-index',
      embeddingProfile: 'test',
      vectorDimension: 8,
      knowledgeFingerprint: 'fingerprint',
      expectedCount: 1,
      createdBy: 'test',
      now: '2026-08-03T00:00:00.000Z',
    });
    indexRepo.markFailed(index.id, 'index_failed', '2026-08-03T00:02:00.000Z');

    const session = new SessionRepo(db).create('trace-user');
    const messages = new MessageRepo(db);
    const user = messages.create({ sessionId: session.id, role: MessageRole.USER, content: 'test' });
    const collector = new RetrievalTraceCollector({ backend: 'memory' });
    collector.record('grounding', {
      status: 'degraded', latencyMs: 1, inputCount: 0, outputCount: 0,
      errorCode: 'trace_degraded',
    });
    new RetrievalTraceRepo(db).create(collector.complete({
      sessionId: session.id,
      userMessageId: user.id,
      assistantMessageId: null,
      policyId: 'policy-test',
    }));

    const service = new OperationsService(db, {
      retrievalStatus: async () => ({
        provider: 'memory',
        qdrantConfigured: false,
        qdrantHealth: 'not_configured',
        alias: 'test', collection: null, points: null, dimensions: null,
        syncStatus: 'not_configured',
      }),
      now: () => new Date('2026-08-03T00:03:00.000Z'),
    });
    const overview = await service.overview();
    assert.equal(overview.generatedAt, '2026-08-03T00:03:00.000Z');
    assert.equal(overview.tasks.total.failed, 2);
    assert.equal(overview.services.find((item) => item.key === 'answer')?.health, 'healthy');
    assert.equal(overview.services.find((item) => item.key === 'qdrant')?.health, 'optional_disabled');
    assert.equal(overview.services.find((item) => item.key === 'ocr')?.health, 'optional_disabled');
    assert.ok(overview.recentProblems.length <= overview.limits.recentProblems);
    assert.equal(
      overview.recentProblems.find((item) => item.kind === 'document')?.recovery,
      'retry_document',
    );
    assert.equal(
      overview.recentProblems.find((item) => item.kind === 'quality')?.recovery,
      'rerun_quality',
    );
    assert.equal(
      overview.recentProblems.find((item) => item.kind === 'index')?.recovery,
      null,
    );
  } finally {
    db.close();
  }
}

void testBoundedOverviewAndRecoveryMapping().then(() => {
  console.log('operations service tests passed');
});
