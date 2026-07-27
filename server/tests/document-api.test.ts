import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
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
  let ocrRequestCount = 0;
  let ocrServer: Server | null = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/extractions');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        source: { contentBase64: string };
      };
      assert.ok(body.source.contentBase64);
      ocrRequestCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: {
          contractVersion: 'ocr-extraction-v1',
          engine: {
            name: 'paddleocr_ppstructurev3',
            version: '3.0.0',
          },
          blocks: [
            {
              id: 'block-000001',
              order: 0,
              kind: 'paragraph',
              pageNumber: 1,
              headingPath: [],
              confidence: 0.96,
              layout: { x: 8, y: 12, width: 400, height: 80 },
              excluded: false,
              exclusionReason: null,
              text: '图片中的退款政策：签收后七天内可以申请退款。',
            },
          ],
          warnings: [],
          metrics: {
            pageCount: 1,
            blockCount: 1,
            elapsedMs: 12,
          },
        },
        message: 'ok',
      }));
    });
  });
  ocrServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => ocrServer?.once('listening', resolve));
  process.env.OCR_SERVICE_URL = `http://127.0.0.1:${(ocrServer.address() as AddressInfo).port}`;
  process.env.OCR_ENGINE_VERSION = '3.0.0';

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
    form.append('file', new Blob(['退款政策\n\n签收后七天内可以申请退款，并提供订单号。'], { type: 'text/plain' }), 'refund-policy.txt');
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
    assert.deepEqual(chunks.data.items[0].sourceBlockIds, ['block-000001', 'block-000002']);

    const detail = await (await fetch(`${base}/api/admin/documents/${documentId}`, { headers: auth })).json() as {
      data: {
        representationSummary: { schemaVersion: string; blockCount: number };
        processingSummary: { status: string; stages: Array<{ name: string; status: string }> };
      };
    };
    assert.equal(detail.data.representationSummary.schemaVersion, 'document-ir-v1');
    assert.equal(detail.data.representationSummary.blockCount, 2);
    assert.equal(detail.data.processingSummary.status, 'succeeded');
    assert.equal(detail.data.processingSummary.stages.at(-1)?.name, 'publish');

    const blocks = await (await fetch(
      `${base}/api/admin/documents/${documentId}/blocks?page=1&pageSize=1`,
      { headers: auth },
    )).json() as {
      data: { items: Array<Record<string, unknown>>; total: number; representationVersion: string };
    };
    assert.equal(blocks.data.total, 2);
    assert.equal(blocks.data.items.length, 1);
    assert.equal(blocks.data.items[0].kind, 'paragraph');
    assert.equal(blocks.data.representationVersion, 'document-ir-v1');
    assert.equal('embedding' in blocks.data.items[0], false);

    const reprocess = await fetch(`${base}/api/admin/documents/${documentId}/reprocess`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'document-reprocess-current-v1' },
    });
    assert.equal(reprocess.status, 200);
    const reprocessBody = await reprocess.json() as { data: { id: string; status: string } };
    assert.equal(reprocessBody.data.id, documentId);
    assert.equal(reprocessBody.data.status, 'ready');

    const shortForm = new FormData();
    shortForm.append('file', new Blob(['Too short'], { type: 'text/plain' }), 'short.txt');
    const shortUpload = await fetch(`${base}/api/admin/documents`, {
      method: 'POST',
      headers: auth,
      body: shortForm,
    });
    assert.equal(shortUpload.status, 201);
    const shortBody = await shortUpload.json() as {
      data: {
        id: string;
        status: string;
        qualityDecision: string;
        qualityReasons: string[];
        failureCode: string;
        indexStatus: string;
      };
    };
    assert.equal(shortBody.data.status, 'failed');
    assert.equal(shortBody.data.qualityDecision, 'review_required');
    assert.deepEqual(shortBody.data.qualityReasons, ['near_empty_content']);
    assert.equal(shortBody.data.failureCode, 'quality_review_required');
    assert.equal(shortBody.data.indexStatus, 'not_indexed');
    assert.equal((await fetch(`${base}/api/admin/documents/${shortBody.data.id}/retry`, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'document-short-retry-v1' },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/documents/${shortBody.data.id}`, {
      method: 'DELETE',
      headers: auth,
    })).status, 200);

    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('document-api-image'),
    ]);
    const imageForm = new FormData();
    imageForm.append(
      'file',
      new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }),
      'refund-screenshot.png',
    );
    const imageUpload = await fetch(`${base}/api/admin/documents`, {
      method: 'POST',
      headers: auth,
      body: imageForm,
    });
    assert.equal(imageUpload.status, 201);
    const imageBody = await imageUpload.json() as {
      data: {
        id: string;
        format: string;
        status: string;
        failureCode: string;
        indexStatus: string;
      };
    };
    assert.equal(imageBody.data.format, 'png');
    assert.equal(imageBody.data.status, 'failed');
    assert.equal(imageBody.data.failureCode, 'ocr_review_required');
    assert.equal(imageBody.data.indexStatus, 'not_indexed');
    assert.equal(ocrRequestCount, 1);

    const imageDetail = await (await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}`,
      { headers: auth },
    )).json() as {
      data: {
        extractionSummary: { status: string; engine: string; blockCount: number };
        reviewDraftSummary: { status: string; revision: number; blockCount: number };
      };
    };
    assert.equal(imageDetail.data.extractionSummary.status, 'succeeded');
    assert.equal(imageDetail.data.extractionSummary.engine, 'paddleocr_ppstructurev3');
    assert.equal(imageDetail.data.extractionSummary.blockCount, 1);
    assert.equal(imageDetail.data.reviewDraftSummary.status, 'open');
    assert.equal(imageDetail.data.reviewDraftSummary.revision, 1);
    assert.equal(imageDetail.data.reviewDraftSummary.blockCount, 1);

    const imageDraft = await (await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}/review-draft?page=1&pageSize=1`,
      { headers: auth },
    )).json() as {
      data: {
        items: Array<Record<string, unknown>>;
        total: number;
        revision: number;
        status: string;
      };
    };
    assert.equal(imageDraft.data.total, 1);
    assert.equal(imageDraft.data.items[0].kind, 'paragraph');
    assert.equal(imageDraft.data.items[0].manuallyEdited, false);
    assert.equal(imageDraft.data.revision, 1);
    assert.equal(imageDraft.data.status, 'open');
    const editedImageBlocks = imageDraft.data.items.map((item) => ({
      ...item,
      text: '图片中的退款政策：签收后七个自然日内可以申请退款。',
    }));
    const imageDraftUpdate = await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}/review-draft`,
      {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          blocks: editedImageBlocks,
        }),
      },
    );
    assert.equal(imageDraftUpdate.status, 200);
    const imageDraftUpdateBody = await imageDraftUpdate.json() as {
      data: { revision: number; items: Array<{ text?: string; manuallyEdited: boolean }> };
    };
    assert.equal(imageDraftUpdateBody.data.revision, 2);
    assert.equal(imageDraftUpdateBody.data.items[0].manuallyEdited, true);
    assert.match(imageDraftUpdateBody.data.items[0].text ?? '', /七个自然日/);

    const staleImageDraftUpdate = await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}/review-draft`,
      {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          blocks: editedImageBlocks,
        }),
      },
    );
    assert.equal(staleImageDraftUpdate.status, 409);

    const imagePublish = await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}/review-draft/publish`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 2 }),
      },
    );
    assert.equal(imagePublish.status, 200);
    const imagePublishBody = await imagePublish.json() as {
      data: {
        status: string;
        indexStatus: string;
        reviewDraftSummary: { status: string; revision: number };
      };
    };
    assert.equal(imagePublishBody.data.status, 'ready');
    assert.equal(imagePublishBody.data.indexStatus, 'published');
    assert.equal(imagePublishBody.data.reviewDraftSummary.status, 'published');
    assert.equal(imagePublishBody.data.reviewDraftSummary.revision, 2);
    const publishedImageChunks = await (await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}/chunks?page=1&pageSize=20`,
      { headers: auth },
    )).json() as { data: { items: Array<{ content: string; sourceBlockIds: string[] }> } };
    assert.ok(publishedImageChunks.data.items.some((chunk) => (
      chunk.content.includes('七个自然日')
      && chunk.sourceBlockIds.includes('block-000001')
    )));
    assert.equal((await fetch(
      `${base}/api/admin/documents/${imageBody.data.id}`,
      { method: 'DELETE', headers: auth },
    )).status, 200);

    const duplicateForm = new FormData();
    duplicateForm.append('file', new Blob(['退款政策\n\n签收后七天内可以申请退款，并提供订单号。'], { type: 'text/plain' }), 'copy.txt');
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
    await closeServer(ocrServer);
    ocrServer = null;
    databaseModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
