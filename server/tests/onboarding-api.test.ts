import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

function parseSse(text: string): Array<{ type: string; content: Record<string, unknown> }> {
  return text.split('\n\n')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)) as { type: string; content: Record<string, unknown> });
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-api-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'onboarding-api-secret';
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.DOCUMENT_UPLOAD_DIR = path.join(tempDir, 'uploads');
  process.env.LLM_PROVIDER = 'other';
  process.env.LLM_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.EMBED_PROVIDER = 'other';
  process.env.EMBED_API_KEY = '';
  process.env.VECTOR_STORE_PROVIDER = 'memory';
  process.env.OCR_BACKGROUND_ENABLED = 'false';

  const [
    { default: onboardingRoutes },
    { default: chatRoutes },
    { errorHandler },
    databaseModule,
    { semanticSearch },
    { SessionRepo },
  ] = await Promise.all([
    import('../routes/admin/onboarding'),
    import('../routes/chat'),
    import('../middleware/errorHandler'),
    import('../db'),
    import('../ai/semantic-search'),
    import('../db/repos/session.repo'),
  ]);
  const db = databaseModule.getDatabase();
  await semanticSearch.initialize();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/onboarding', onboardingRoutes);
  app.use('/api/chat', chatRoutes);
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
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/admin/onboarding`)).status, 401);

    const initial = await (await fetch(`${base}/api/admin/onboarding`, { headers: auth })).json() as {
      data: { status: string; shouldAutoRedirect: boolean };
    };
    assert.equal(initial.data.status, 'not_started');
    assert.equal(initial.data.shouldAutoRedirect, true);

    const start = await (await fetch(`${base}/api/admin/onboarding/start`, {
      method: 'POST', headers: auth,
    })).json() as { data: { runId: string } };
    assert.ok(start.data.runId);
    assert.equal((await fetch(`${base}/api/admin/onboarding/sample-pack`, {
      method: 'POST', headers: auth,
    })).status, 400);
    const sample = await fetch(`${base}/api/admin/onboarding/sample-pack`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'sample-pack-install-v1' },
    });
    assert.equal(sample.status, 200);
    const sampleBody = await sample.json() as { data: { samplePack: { status: string; documentId: string } } };
    assert.equal(sampleBody.data.samplePack.status, 'ready');
    assert.ok(sampleBody.data.samplePack.documentId);
    const replay = await fetch(`${base}/api/admin/onboarding/sample-pack`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'sample-pack-install-v1' },
    });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '退货申请需要在几天内提交？',
        userIdent: 'guided-onboarding-user',
        onboardingRunId: start.data.runId,
      }),
    });
    assert.equal(chat.status, 200);
    const done = parseSse(await chat.text()).find((event) => event.type === 'done')?.content;
    assert.ok(done);
    assert.equal(done?.groundingStatus, 'sufficient');
    assert.ok((done?.knowledgeSources as Array<{ knowledgeType: string; documentId?: string }>).some(
      (source) => source.knowledgeType === 'document'
        && source.documentId === sampleBody.data.samplePack.documentId,
    ));

    const guided = await fetch(`${base}/api/admin/onboarding/guided-answer`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: done?.sessionId, messageId: done?.messageId }),
    });
    assert.equal(guided.status, 200);
    const reviewed = await fetch(`${base}/api/admin/onboarding/evidence-reviewed`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: done?.messageId }),
    });
    assert.equal(reviewed.status, 200);
    const reviewedBody = await reviewed.json() as { data: { status: string; completedAt: string } };
    assert.equal(reviewedBody.data.status, 'completed');
    assert.ok(reviewedBody.data.completedAt);
    assert.equal(new SessionRepo(db).overviewMetrics().totalSessions, 0);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    databaseModule.closeDatabase();
  }
}

void main().then(() => console.log('onboarding API tests passed'));
