import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idempotency-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'idempotency-test-secret';
  process.env.DB_PATH = path.join(tempDir, 'test.db');

  const [{ idempotencyMiddleware }, { errorHandler }, databaseModule] = await Promise.all([
    import('../middleware/idempotency'),
    import('../middleware/errorHandler'),
    import('../db'),
  ]);

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', idempotencyMiddleware);

  let jsonCalls = 0;
  app.post('/api/write', (req, res) => {
    jsonCalls += 1;
    res.status(201).json({
      code: 0,
      data: { call: jsonCalls, value: req.body.value },
      message: 'created',
    });
  });

  let streamCalls = 0;
  app.post('/api/stream', (_req, res) => {
    streamCalls += 1;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.write(`data: ${JSON.stringify({ type: 'token', content: `answer-${streamCalls}` })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'done', content: { call: streamCalls } })}\n\n`);
  });
  let callbackStreamCalls = 0;
  app.post('/api/callback-stream', (_req, res) => {
    callbackStreamCalls += 1;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write('callback-', () => {});
    res.end(String(callbackStreamCalls), () => {});
  });

  let releaseSlowRequest: () => void = () => {};
  let slowRequestStarted: (() => void) | null = null;
  const slowStarted = new Promise<void>((resolve) => {
    slowRequestStarted = resolve;
  });
  app.post('/api/slow', async (_req, res) => {
    slowRequestStarted?.();
    await new Promise<void>((resolve) => {
      releaseSlowRequest = resolve;
    });
    res.json({ code: 0, data: { ok: true }, message: 'ok' });
  });
  app.post('/api/disconnected', (_req, res) => {
    res.destroy();
  });

  app.use(errorHandler);

  let server: Server | null = null;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const withoutKey = () => fetch(`${base}/api/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'compatible' }),
    });
    assert.equal((await withoutKey()).status, 201);
    assert.equal((await withoutKey()).status, 201);
    assert.equal(jsonCalls, 2, 'requests without Idempotency-Key must remain backward compatible');

    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'json-request-0001',
    };
    const first = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: 'same' }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.text();

    const replay = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: 'same' }),
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(await replay.text(), firstBody);
    assert.equal(jsonCalls, 3, 'a replayed request must not execute the handler again');

    const actorScopedHeaders = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'actor-request-0001',
    };
    const firstActor = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers: { ...actorScopedHeaders, 'X-Forwarded-For': '192.0.2.1' },
      body: JSON.stringify({ value: 'actor-scoped' }),
    });
    const secondActor = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers: { ...actorScopedHeaders, 'X-Forwarded-For': '192.0.2.2' },
      body: JSON.stringify({ value: 'actor-scoped' }),
    });
    assert.equal(firstActor.status, 201);
    assert.equal(secondActor.status, 201);
    assert.equal(secondActor.headers.get('idempotency-replayed'), null);
    assert.equal(jsonCalls, 5, 'different anonymous owners must not share replay records');

    const mismatched = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: 'different' }),
    });
    assert.equal(mismatched.status, 409);
    assert.match((await mismatched.json() as { message: string }).message, /different request/i);
    assert.equal(jsonCalls, 5);

    const invalid = await fetch(`${base}/api/write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'bad key',
      },
      body: JSON.stringify({ value: 'invalid' }),
    });
    assert.equal(invalid.status, 400);

    const firstSlow = fetch(`${base}/api/slow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'slow-request-0001',
      },
      body: JSON.stringify({ value: 'slow' }),
    });
    await slowStarted;
    const concurrent = await fetch(`${base}/api/slow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'slow-request-0001',
      },
      body: JSON.stringify({ value: 'slow' }),
    });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.headers.get('retry-after'), null);
    releaseSlowRequest();
    assert.equal((await firstSlow).status, 200);

    const disconnectedRequest = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'disconnect-request-0001',
      },
      body: JSON.stringify({ value: 'unknown-outcome' }),
    };
    await assert.rejects(fetch(`${base}/api/disconnected`, disconnectedRequest));
    const disconnectedRetry = await fetch(`${base}/api/disconnected`, disconnectedRequest);
    assert.equal(disconnectedRetry.status, 409);
    assert.match(
      (await disconnectedRetry.json() as { message: string }).message,
      /still processing/i,
    );

    const streamHeaders = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Idempotency-Key': 'stream-request-0001',
    };
    const firstStream = await fetch(`${base}/api/stream`, {
      method: 'POST',
      headers: streamHeaders,
      body: JSON.stringify({ message: 'hello' }),
    });
    const firstStreamBody = await firstStream.text();
    const replayedStream = await fetch(`${base}/api/stream`, {
      method: 'POST',
      headers: streamHeaders,
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(replayedStream.headers.get('idempotency-replayed'), 'true');
    assert.equal(replayedStream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(await replayedStream.text(), firstStreamBody);
    assert.equal(streamCalls, 1, 'SSE replay must not execute the stream handler again');

    const callbackHeaders = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'callback-request-0001',
    };
    const callbackStream = await fetch(`${base}/api/callback-stream`, {
      method: 'POST',
      headers: callbackHeaders,
      body: '{}',
    });
    assert.equal(await callbackStream.text(), 'callback-1');
    const callbackReplay = await fetch(`${base}/api/callback-stream`, {
      method: 'POST',
      headers: callbackHeaders,
      body: '{}',
    });
    assert.equal(await callbackReplay.text(), 'callback-1');
    assert.equal(callbackReplay.headers.get('idempotency-replayed'), 'true');
    assert.equal(callbackStreamCalls, 1, 'response callback overloads must remain replayable');

    console.log('idempotency middleware tests passed');
  } finally {
    await closeServer(server);
    databaseModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
