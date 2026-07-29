import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-api-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'retrieval-api-secret';
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.VECTOR_STORE_PROVIDER = 'memory';
  process.env.QDRANT_URL = '';

  const [
    { default: router },
    { errorHandler },
    databaseModule,
    { RetrievalTraceCollector },
    { getRetrievalTraceService },
    { SessionRepo },
    { MessageRepo },
    { MessageRole },
  ] = await Promise.all([
    import('../routes/admin/retrieval'),
    import('../middleware/errorHandler'),
    import('../db'),
    import('../services/retrieval-trace-collector'),
    import('../services/retrieval-trace.service'),
    import('../db/repos/session.repo'),
    import('../db/repos/message.repo'),
    import('../types/domain'),
  ]);
  const db = databaseModule.getDatabase();
  const session = new SessionRepo(db).create('trace-api-user');
  const messageRepo = new MessageRepo(db);
  const userMessage = messageRepo.create({
    sessionId: session.id,
    role: MessageRole.USER,
    content: 'authorized trace question',
  });
  const assistantMessage = messageRepo.create({
    sessionId: session.id,
    role: MessageRole.ASSISTANT,
    content: 'authorized trace answer',
    replyToMessageId: userMessage.id,
  });
  const collector = new RetrievalTraceCollector({ backend: 'memory' });
  collector.record('grounding', {
    status: 'completed',
    latencyMs: 1,
    inputCount: 0,
    outputCount: 0,
  });
  getRetrievalTraceService().persist(collector.complete({
    sessionId: session.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    policyId: 'policy-test',
  }));
  const app = express();
  app.use(express.json());
  app.use('/api/admin/retrieval', router);
  app.use(errorHandler);
  const token = jwt.sign(
    { id: 'admin-id', username: 'admin', role: 'admin' },
    process.env.JWT_SECRET,
  );
  const auth = { Authorization: `Bearer ${token}` };
  let server: Server | null = null;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      + '/api/admin/retrieval';

    assert.equal((await fetch(`${base}/status`)).status, 401);
    const status = await fetch(`${base}/status`, { headers: auth });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as {
      data: { provider: string; qdrantConfigured: boolean; qdrantHealth: string };
    };
    assert.equal(statusBody.data.provider, 'memory');
    assert.equal(statusBody.data.qdrantConfigured, false);
    assert.equal(statusBody.data.qdrantHealth, 'not_configured');

    const traceList = await fetch(
      `${base}/traces?backend=memory&sessionId=${session.id}`,
      { headers: auth },
    );
    assert.equal(traceList.status, 200);
    const traceListBody = await traceList.json() as {
      data: { total: number; items: Array<{ id: string }> };
    };
    assert.equal(traceListBody.data.total, 1);
    const traceDetail = await fetch(
      `${base}/traces/${traceListBody.data.items[0].id}`,
      { headers: auth },
    );
    const traceDetailBody = await traceDetail.json() as {
      data: {
        trace: { stages: unknown[] };
        messages: { user: { content: string }; assistant: { content: string } };
      };
    };
    assert.equal(traceDetailBody.data.trace.stages.length, 8);
    assert.equal(traceDetailBody.data.messages.user.content, 'authorized trace question');
    assert.equal(traceDetailBody.data.messages.assistant.content, 'authorized trace answer');

    assert.equal(
      (await fetch(`${base}/index-jobs?pageSize=101`, { headers: auth })).status,
      400,
    );
    const missingKey = await fetch(`${base}/index-jobs`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingKey.status, 400);
    const noQdrant = await fetch(`${base}/index-jobs`, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'retrieval-create-without-qdrant',
      },
      body: '{}',
    });
    assert.equal(noQdrant.status, 409);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    databaseModule.closeDatabase();
    fs.rmSync(path.join(tempDir, 'test.db'), { force: true });
    fs.rmdirSync(tempDir);
  }
  console.log('retrieval API tests passed');
}

void main();
