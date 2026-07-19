import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';

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
  llmClient.chatStream = async () => {
    throw new Error('simulated LLM stream failure');
  };

  const [{ default: chatRouter }, { errorHandler }, databaseModule] = await Promise.all([
    import('../routes/chat'),
    import('../middleware/errorHandler'),
    import('../db'),
  ]);

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
    assert.ok(events.some((event) => event.type === 'error'));
    assert.ok(!events.some((event) => event.type === 'done'));

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
    const reviewCount = db.prepare('SELECT COUNT(*) AS total FROM knowledge_review_items').get() as { total: number };
    assert.equal(reviewCount.total, 0);

    console.log('Chat route failure checks passed');
  } finally {
    llmClient.chatStream = originalChatStream;
    await closeServer(server);
    databaseModule.closeDatabase();
    removeTestDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
