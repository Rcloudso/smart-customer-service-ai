import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { OnboardingService } from '../services/onboarding.service';
import { Document, MessageRole } from '../types/domain';
import { NotFoundError, ValidationError } from '../utils/errors';

const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';

function readyDocument(): Document {
  return {
    id: DOCUMENT_ID,
    fileName: 'demo-return-policy-bilingual.md',
    format: 'md',
    mimeType: 'text/markdown',
    sizeBytes: 100,
    status: 'ready',
    isActive: 1,
    parserVersion: 'test',
    chunkerVersion: 'test',
    failureCode: null,
    characterCount: 100,
    chunkCount: 1,
    sourceVersion: 1,
    representationVersion: 'test',
    cleanerVersion: 'test',
    qualityDecision: 'ready',
    qualityReasons: [],
    latestTaskId: null,
    latestRepresentationId: null,
    indexStatus: 'published',
    uploadedBy: 'sample-pack-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function testSamplePackAndGroundedCompletion(): Promise<void> {
  const db = new Database(':memory:');
  let uploads = 0;
  let indexUpdates = 0;
  try {
    db.pragma('foreign_keys = ON');
    initSchema(db);
    const service = new OnboardingService(db, {
      updateFaqIndex: async () => { indexUpdates += 1; },
      uploadDocument: async () => { uploads += 1; return readyDocument(); },
      retryDocument: async () => readyDocument(),
    });

    const started = service.start();
    assert.equal(started.status, 'in_progress');
    assert.ok(started.runId);
    await service.installSamplePack();
    await service.installSamplePack();
    assert.equal(uploads, 1);
    assert.equal(indexUpdates, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS total FROM faq_entries WHERE updated_by = 'sample-pack-v1'").get() as { total: number }).total,
      6,
    );

    const sessions = new SessionRepo(db);
    const messages = new MessageRepo(db);
    const customer = sessions.create('forged-user');
    const forged = messages.create({
      sessionId: customer.id,
      role: MessageRole.ASSISTANT,
      content: 'forged',
      answerMode: 'grounded_generation',
      groundingStatus: 'sufficient',
      retrievalSnapshot: [{
        knowledgeType: 'document', knowledgeId: 'chunk', documentId: DOCUMENT_ID,
        title: 'demo', similarity: 1,
      }],
    });
    assert.throws(
      () => service.recordGuidedAnswer({ sessionId: customer.id, messageId: forged.id }),
      NotFoundError,
    );

    const onboarding = sessions.create('guided-user', {
      origin: 'onboarding',
      onboardingRunId: started.runId,
    });
    const answer = messages.create({
      sessionId: onboarding.id,
      role: MessageRole.ASSISTANT,
      content: '7 days',
      answerMode: 'grounded_generation',
      groundingStatus: 'sufficient',
      retrievalSnapshot: [{
        knowledgeType: 'document', knowledgeId: 'chunk', documentId: DOCUMENT_ID,
        title: 'Demo Return Policy', similarity: 0.9,
      }],
    });
    const answered = service.recordGuidedAnswer({ sessionId: onboarding.id, messageId: answer.id });
    assert.equal(answered.firstAnswerMessageId, answer.id);
    assert.throws(() => service.evidenceReviewed(forged.id), ValidationError);
    const completed = service.evidenceReviewed(answer.id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt);
    assert.equal(sessions.overviewMetrics().totalSessions, 1);
  } finally {
    db.close();
  }
}

void testSamplePackAndGroundedCompletion().then(() => {
  console.log('onboarding service tests passed');
});
