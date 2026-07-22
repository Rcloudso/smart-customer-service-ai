import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { IntentCategory } from '../types/domain';

const dbPath = path.resolve(process.cwd(), 'data/chat-route-test.db');

function removeTestDatabase(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function parseSse(text: string): Array<{ type: string; content: unknown }> {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  removeTestDatabase();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-123';
  process.env.DB_PATH = dbPath;
  process.env.LLM_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.LLM_API_BASE = '';
  process.env.EMBED_PROVIDER = 'other';
  process.env.EMBED_API_KEY = '';

  const { getLLMClient } = await import('../ai/llm-client');
  const llmClient = getLLMClient();
  const originalChatStream = llmClient.chatStream;
  let streamCalls = 0;
  llmClient.chatStream = async () => {
    streamCalls += 1;
    throw new Error('simulated LLM stream failure');
  };

  const [{ default: chatRouter }, { errorHandler }, databaseModule, { intentService }] = await Promise.all([
    import('../routes/chat'),
    import('../middleware/errorHandler'),
    import('../db'),
    import('../services/intent.service'),
  ]);
  const originalProcessMessage = intentService.processMessage;

  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use(errorHandler);

  let server: Server | null = null;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: '请转人工客服',
        userIdent: 'explicit-escalation-failure-test',
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    assert.ok(events.some((event) => event.type === 'escalate'));
    assert.ok(events.some((event) => event.type === 'token'));
    assert.ok(!events.some((event) => event.type === 'error'));
    const done = events.find((event) => event.type === 'done')?.content as Record<string, unknown>;
    assert.equal(done.answerMode, 'refusal');
    assert.equal(done.groundingStatus, 'escalated');
    assert.equal(done.groundingReason, 'user_requested_human');
    assert.deepEqual(done.knowledgeSources, []);
    assert.equal(streamCalls, 0);

    const db = databaseModule.getDatabase();
    const escalation = db.prepare(
      'SELECT reason, status FROM escalation_log ORDER BY created_at DESC LIMIT 1',
    ).get() as { reason: string; status: string } | undefined;
    assert.deepEqual(escalation, {
      reason: '用户明确要求转人工客服',
      status: 'pending',
    });
    const session = db.prepare('SELECT status FROM sessions LIMIT 1').get() as { status: string };
    assert.equal(session.status, 'escalated');
    const assistant = db.prepare(
      `SELECT answer_mode AS answerMode, grounding_status AS groundingStatus,
              grounding_reason AS groundingReason
       FROM messages WHERE role = 'assistant' LIMIT 1`,
    ).get() as { answerMode: string; groundingStatus: string; groundingReason: string };
    assert.deepEqual(assistant, {
      answerMode: 'refusal',
      groundingStatus: 'escalated',
      groundingReason: 'user_requested_human',
    });
    const reviewCount = db.prepare('SELECT COUNT(*) AS total FROM knowledge_review_items').get() as { total: number };
    assert.equal(reviewCount.total, 0);

    const refusalResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: '你们可以把商品配送到火星吗？',
        userIdent: 'no-evidence-test',
      }),
    });
    assert.equal(refusalResponse.status, 200);
    const refusalEvents = parseSse(await refusalResponse.text());
    assert.ok(!refusalEvents.some((event) => event.type === 'escalate'));
    assert.ok(!refusalEvents.some((event) => event.type === 'error'));
    const refusalDone = refusalEvents.find((event) => event.type === 'done')?.content as Record<string, unknown>;
    assert.equal(refusalDone.answerMode, 'refusal');
    assert.equal(refusalDone.groundingStatus, 'insufficient');
    assert.equal(refusalDone.groundingReason, 'no_evidence');
    assert.deepEqual(refusalDone.knowledgeSources, []);
    assert.equal(streamCalls, 0);
    const reviewCountBeforeHighRisk = db.prepare(
      'SELECT COUNT(*) AS total FROM knowledge_review_items',
    ).get() as { total: number };

    const highRiskResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: '请直接帮我取消订单 12345 并退款',
        userIdent: 'high-risk-action-test',
      }),
    });
    assert.equal(highRiskResponse.status, 200);
    const highRiskEvents = parseSse(await highRiskResponse.text());
    assert.ok(highRiskEvents.some((event) => event.type === 'escalate'));
    assert.ok(!highRiskEvents.some((event) => event.type === 'error'));
    const highRiskDone = highRiskEvents.find((event) => event.type === 'done')?.content as Record<string, unknown>;
    assert.equal(highRiskDone.answerMode, 'refusal');
    assert.equal(highRiskDone.groundingStatus, 'high_risk');
    assert.equal(highRiskDone.groundingReason, 'unsupported_business_action');
    assert.equal(streamCalls, 0);

    const highRiskEscalation = db.prepare(
      'SELECT reason, status FROM escalation_log ORDER BY created_at DESC LIMIT 1',
    ).get() as { reason: string; status: string } | undefined;
    assert.deepEqual(highRiskEscalation, {
      reason: '当前请求涉及尚未授权的业务操作，需要人工处理',
      status: 'pending',
    });
    const highRiskAssistant = db.prepare(
      `SELECT answer_mode AS answerMode, grounding_status AS groundingStatus,
              grounding_reason AS groundingReason, escalated
       FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get() as {
      answerMode: string;
      groundingStatus: string;
      groundingReason: string;
      escalated: number;
    };
    assert.deepEqual(highRiskAssistant, {
      answerMode: 'refusal',
      groundingStatus: 'high_risk',
      groundingReason: 'unsupported_business_action',
      escalated: 1,
    });
    const reviewCountAfterHighRisk = db.prepare(
      'SELECT COUNT(*) AS total FROM knowledge_review_items',
    ).get() as { total: number };
    assert.equal(
      reviewCountAfterHighRisk.total,
      reviewCountBeforeHighRisk.total,
      'unsupported business actions should not be misclassified as knowledge gaps',
    );

    intentService.processMessage = async () => ({
      intent: {
        intent: IntentCategory.GENERAL,
        confidence: 0.9,
        reasoning: 'empty stream test',
      },
      faqMatches: [],
      retrievalResults: [{
        knowledgeType: 'document',
        knowledgeId: 'empty-stream-evidence',
        documentId: 'empty-stream-document',
        title: '测试文档',
        content: '足够的测试依据',
        similarity: 0.8,
        source: 'vector',
        vectorScore: 0.8,
      }],
      needsEscalation: false,
      escalationReason: null,
      escalationType: null,
    });
    llmClient.chatStream = async () => {
      streamCalls += 1;
      return '';
    };
    const assistantCountBeforeEmptyStream = db.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE role = 'assistant'",
    ).get() as { total: number };
    const emptyStreamResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: '测试空生成流',
        userIdent: 'empty-stream-test',
      }),
    });
    assert.equal(emptyStreamResponse.status, 200);
    const emptyStreamEvents = parseSse(await emptyStreamResponse.text());
    assert.ok(emptyStreamEvents.some((event) => event.type === 'error'));
    assert.ok(!emptyStreamEvents.some((event) => event.type === 'done'));
    const assistantCountAfterEmptyStream = db.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE role = 'assistant'",
    ).get() as { total: number };
    assert.equal(
      assistantCountAfterEmptyStream.total,
      assistantCountBeforeEmptyStream.total,
      'empty generated answers must not be persisted as successful assistant messages',
    );

    console.log('Chat route failure checks passed');
  } finally {
    llmClient.chatStream = originalChatStream;
    intentService.processMessage = originalProcessMessage;
    await closeServer(server);
    databaseModule.closeDatabase();
    removeTestDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
