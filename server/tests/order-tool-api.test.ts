import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const dbPath = path.join(os.tmpdir(), 'resolveweave-order-tool-api.db');

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
  process.env.ORDER_TOOL_PROVIDER = 'demo';
  process.env.LLM_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.EMBED_PROVIDER = 'other';

  const [
    { default: chatRouter },
    { errorHandler },
    databaseModule,
    { intentService },
  ] = await Promise.all([
    import('../routes/chat'),
    import('../middleware/errorHandler'),
    import('../db'),
    import('../services/intent.service'),
  ]);
  const originalProcessMessage = intentService.processMessage;
  let intentCalls = 0;
  intentService.processMessage = async (...args) => {
    intentCalls += 1;
    return originalProcessMessage.apply(intentService, args);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use(errorHandler);
  let server: Server | null = null;

  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/chat`;

    const chatResponse = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        message: '查询订单 RW-DEMO-1002 的物流状态',
        userIdent: 'browser-a',
      }),
    });
    assert.equal(chatResponse.status, 200);
    const events = parseSse(await chatResponse.text());
    const toolEvent = events.find((event) => event.type === 'tool')?.content as Record<string, unknown>;
    assert.equal(toolEvent.status, 'verification_required');
    assert.equal(toolEvent.maskedOrderReference, 'RW-••••-1002');
    const done = events.find((event) => event.type === 'done')?.content as Record<string, unknown>;
    const sessionId = done.sessionId as string;
    assert.ok(sessionId);
    assert.equal(intentCalls, 0, 'private lookup must route before model and RAG');

    const db = databaseModule.getDatabase();
    const storedAfterChat = JSON.stringify(db.prepare('SELECT * FROM messages').all());
    assert.equal(storedAfterChat.includes('RW-DEMO-1002'), false);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM retrieval_traces').get() as { count: number }).count,
      0,
    );

    const invalid = await fetch(`${base}/tools/order/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userIdent: 'browser-a',
        orderReference: 'RW-DEMO-1002',
        verificationCode: '000000',
      }),
    });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json() as { message: string }).message, '订单号或验证码无效');

    const verified = await fetch(`${base}/tools/order/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'verify-must-not-replay',
      },
      body: JSON.stringify({
        sessionId,
        userIdent: 'browser-a',
        orderReference: 'RW-DEMO-1002',
        verificationCode: '135790',
      }),
    });
    assert.equal(verified.status, 200);
    const setCookie = verified.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^rw_order_grant=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/api\/chat/i);
    assert.doesNotMatch(setCookie, /verification|135790|RW-DEMO/i);
    assert.equal(verified.headers.get('Idempotency-Replayed'), null);
    const cookie = setCookie.split(';')[0];

    const missingKey = await fetch(`${base}/tools/order/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sessionId, userIdent: 'browser-a' }),
    });
    assert.equal(missingKey.status, 400);

    const noCookie = await fetch(`${base}/tools/order/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'lookup-no-cookie' },
      body: JSON.stringify({ sessionId, userIdent: 'browser-a' }),
    });
    assert.equal(noCookie.status, 401);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM tool_executions').get() as { count: number }).count,
      0,
    );

    const lookup = await fetch(`${base}/tools/order/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'lookup-success-0001',
        Cookie: cookie,
      },
      body: JSON.stringify({ sessionId, userIdent: 'browser-a' }),
    });
    assert.equal(lookup.status, 200);
    const lookupBody = await lookup.json() as {
      data: { result: { shippingStatus: string }; messageId: string; executionId: string };
    };
    assert.equal(lookupBody.data.result.shippingStatus, 'in_transit');
    assert.ok(lookupBody.data.messageId);
    assert.ok(lookupBody.data.executionId);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM tool_executions').get() as { count: number }).count,
      1,
    );

    const replay = await fetch(`${base}/tools/order/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'lookup-success-0001',
        Cookie: cookie,
      },
      body: JSON.stringify({ sessionId, userIdent: 'browser-a' }),
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.headers.get('Idempotency-Replayed'), null);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM tool_executions').get() as { count: number }).count,
      1,
    );

    const persisted = JSON.stringify({
      messages: db.prepare('SELECT * FROM messages').all(),
      executions: db.prepare('SELECT * FROM tool_executions').all(),
      grants: db.prepare('SELECT * FROM order_access_grants').all(),
      idempotency: db.prepare('SELECT * FROM idempotency_records').all(),
    });
    for (const secret of ['RW-DEMO-1002', '135790', cookie]) {
      assert.equal(persisted.includes(secret), false, `persisted data leaked ${secret}`);
    }
    assert.equal(persisted.includes('departed_origin'), true, 'safe enum audit is allowed');
    assert.equal(persisted.includes('in_transit'), true, 'safe enum audit is allowed');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count,
      0,
      'transient lookup responses must not enter generic idempotency storage',
    );

    const reuseChat = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: cookie,
      },
      body: JSON.stringify({
        sessionId,
        message: '再次查询订单 RW-DEMO-1002 的物流状态',
        userIdent: 'browser-a',
      }),
    });
    assert.equal(reuseChat.status, 200);
    const reuseEvents = parseSse(await reuseChat.text());
    assert.equal(
      (reuseEvents.find((event) => event.type === 'tool')?.content as Record<string, unknown>).status,
      'running',
    );

    const close = await fetch(`${base}/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIdent: 'browser-a' }),
    });
    assert.equal(close.status, 200);
    const afterClose = await fetch(`${base}/tools/order/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'lookup-after-close',
        Cookie: cookie,
      },
      body: JSON.stringify({ sessionId, userIdent: 'browser-a' }),
    });
    assert.equal(afterClose.status, 401);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM tool_executions').get() as { count: number }).count,
      1,
    );

    console.log('Order tool API checks passed');
  } finally {
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
