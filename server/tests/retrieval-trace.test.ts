import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { RetrievalTraceCollector } from '../services/retrieval-trace-collector';
import { RetrievalTraceService } from '../services/retrieval-trace.service';
import { MessageRole } from '../types/domain';

function testTraceBoundsRetentionAndSessionCascade(): void {
  const db = new Database(':memory:');
  initSchema(db);
  const session = new SessionRepo(db).create('trace-user');
  const messages = new MessageRepo(db);
  const userMessage = messages.create({
    sessionId: session.id,
    role: MessageRole.USER,
    content: 'private customer question',
  });
  const assistantMessage = messages.create({
    sessionId: session.id,
    role: MessageRole.ASSISTANT,
    content: 'private assistant answer',
    replyToMessageId: userMessage.id,
  });
  const collector = new RetrievalTraceCollector({
    backend: 'qdrant',
    now: () => new Date('2026-07-29T00:00:00.000Z'),
  });
  collector.record('vector_recall', {
    status: 'completed',
    latencyMs: 12,
    inputCount: 1,
    outputCount: 25,
    candidates: Array.from({ length: 25 }, (_, index) => ({
      knowledgeType: 'faq' as const,
      knowledgeId: `faq-${index}`,
      score: 1 - index / 100,
      rank: index + 1,
    })),
  });
  collector.record('grounding', {
    status: 'completed',
    latencyMs: 1,
    inputCount: 5,
    outputCount: 4,
    candidates: Array.from({ length: 4 }, (_, index) => ({
      knowledgeType: 'faq' as const,
      knowledgeId: `evidence-${index}`,
      rank: index + 1,
    })),
  });
  const service = new RetrievalTraceService(db, {
    retentionDays: 30,
    now: () => new Date('2026-07-29T00:00:01.000Z'),
  });
  service.persist(collector.complete({
    sessionId: session.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    policyId: 'policy-v1',
  }));

  const detail = service.getTrace(collector.id);
  assert.equal(detail.stages.find((stage) => stage.name === 'vector_recall')?.candidates.length, 20);
  assert.equal(detail.stages.find((stage) => stage.name === 'grounding')?.candidates.length, 3);
  assert.equal(JSON.stringify(detail).includes('private customer question'), false);
  assert.equal(JSON.stringify(detail).includes('private assistant answer'), false);

  db.prepare('UPDATE retrieval_traces SET created_at = ? WHERE id = ?')
    .run('2026-06-01T00:00:00.000Z', collector.id);
  assert.equal(service.cleanupExpired(), 1);

  const second = new RetrievalTraceCollector({ backend: 'memory' });
  service.persist(second.complete({
    sessionId: session.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    policyId: 'policy-v1',
  }));
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  assert.equal(service.listTraces({ page: 1, pageSize: 20 }).total, 0);
  db.close();
}

testTraceBoundsRetentionAndSessionCascade();
console.log('retrieval trace tests passed');
