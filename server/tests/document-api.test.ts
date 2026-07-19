import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

function parseSse(text: string): Array<{ type: string; content: unknown }> {
  return text.split('\n\n').map((part) => part.trim()).filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)) as { type: string; content: unknown });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-api-'));
  const dbPath = path.join(tempDir, 'test.db');
  const uploadDir = path.join(tempDir, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'document-api-secret';
  process.env.DB_PATH = dbPath;
  process.env.DOCUMENT_UPLOAD_DIR = uploadDir;
  process.env.LLM_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.EMBED_PROVIDER = 'other';
  process.env.EMBED_API_KEY = '';

  const [{ default: documentRoutes }, { default: chatRoutes }, { errorHandler }, databaseModule] = await Promise.all([
    import('../routes/admin/documents'),
    import('../routes/chat'),
    import('../middleware/errorHandler'),
    import('../db'),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/admin/documents', documentRoutes);
  app.use('/api/chat', chatRoutes);
  app.use(errorHandler);
  const token = jwt.sign({ id: 'admin-1', username: 'admin', role: 'admin' }, process.env.JWT_SECRET);
  const auth = { Authorization: `Bearer ${token}` };
  let server: Server | null = null;

  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    assert.equal((await fetch(`${base}/api/admin/documents`)).status, 401);
    const form = new FormData();
    form.append('file', new Blob(['退款政策\n\n签收后七天内可以申请退款。'], { type: 'text/plain' }), 'refund-policy.txt');
    const upload = await fetch(`${base}/api/admin/documents`, { method: 'POST', headers: auth, body: form });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json() as { data: Record<string, unknown> };
    assert.equal(uploadBody.data.status, 'ready');
    assert.equal('storagePath' in uploadBody.data, false);
    assert.equal('sha256' in uploadBody.data, false);
    const documentId = uploadBody.data.id as string;

    const chunks = await (await fetch(`${base}/api/admin/documents/${documentId}/chunks`, { headers: auth })).json() as {
      data: { items: Array<Record<string, unknown>> };
    };
    assert.match(chunks.data.items[0].content as string, /七天内/);
    assert.equal('embedding' in chunks.data.items[0], false);

    const duplicateForm = new FormData();
    duplicateForm.append('file', new Blob(['退款政策\n\n签收后七天内可以申请退款。'], { type: 'text/plain' }), 'copy.txt');
    assert.equal((await fetch(`${base}/api/admin/documents`, { method: 'POST', headers: auth, body: duplicateForm })).status, 409);

    const invalidUpdate = await fetch(`${base}/api/admin/documents/${documentId}`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false, fileName: 'renamed.txt' }),
    });
    assert.equal(invalidUpdate.status, 400);

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: '签收后七天内可以申请退款', userIdent: 'document-chat-user' }),
    });
    const events = parseSse(await chat.text());
    assert.ok(!events.some((event) => event.type === 'faq'), 'document results must not leak into the FAQ event');
    const answer = events.filter((event) => event.type === 'token').map((event) => event.content).join('');
    assert.match(answer, /refund-policy\.txt/);
    assert.match(answer, /七天内可以申请退款/);
    assert.ok(events.some((event) => event.type === 'done'));

    assert.equal((await fetch(`${base}/api/admin/documents/${documentId}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal(fs.readdirSync(uploadDir).length, 0);
    console.log('document API tests passed');
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
