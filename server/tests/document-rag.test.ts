import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { DocumentService } from '../services/document.service';

async function testTextUploadPublishesOnlyReadyChunks(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const published: string[][] = [];
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map((_, index) => [1, index + 1]),
    publishChunks: (chunks) => { published.push(chunks.map((chunk) => chunk.content)); },
  });

  try {
    const document = await service.upload({
      originalName: 'refund-policy.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('退款政策\n\n签收后七天内可以申请退款。', 'utf8'),
      uploadedBy: 'admin-1',
    });

    assert.equal(document.status, 'ready');
    assert.equal(document.fileName, 'refund-policy.txt');
    assert.equal(document.chunkCount, 1);
    assert.equal('storagePath' in document, false, 'public document objects must not expose storage paths');

    const chunks = service.listChunks(document.id, { page: 1, pageSize: 20 });
    assert.equal(chunks.total, 1);
    assert.match(chunks.items[0].content, /七天内可以申请退款/);
    assert.deepEqual(published, [['退款政策\n\n签收后七天内可以申请退款。']]);

    const storedFiles = fs.readdirSync(uploadDir);
    assert.equal(storedFiles.length, 1);
    assert.match(storedFiles[0], /^[0-9a-f-]+\.txt$/);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?").get(document.id) as { total: number }).total,
      1,
    );
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testFailureRetryLifecycleAndDuplicateProtection(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-lifecycle-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let embeddingFails = true;
  const removed: string[] = [];
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => {
      if (embeddingFails) throw new Error('provider unavailable');
      return texts.map(() => [1, 0]);
    },
    removeDocumentFromIndex: (documentId) => { removed.push(documentId); },
  });
  const buffer = Buffer.from('物流政策\n\n包裹通常三个工作日送达。');

  try {
    const failed = await service.upload({
      originalName: 'shipping.md',
      mimeType: 'text/markdown',
      buffer,
      uploadedBy: 'admin-1',
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'processing_failed');
    assert.equal(service.listChunks(failed.id, { page: 1, pageSize: 20 }).total, 0);
    assert.equal(fs.readdirSync(uploadDir).length, 1, 'accepted failed uploads remain available for retry');
    await assert.rejects(service.setActive(failed.id, false), /Only ready documents/);

    await assert.rejects(
      service.upload({
        originalName: 'renamed-copy.md',
        mimeType: 'text/markdown',
        buffer,
        uploadedBy: 'admin-1',
      }),
      /identical document/,
    );

    embeddingFails = false;
    const ready = await service.retry(failed.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.failureCode, null);
    assert.ok(ready.chunkCount > 0);
    await assert.rejects(service.retry(ready.id), /Only failed documents/);

    assert.equal((await service.setActive(ready.id, false)).isActive, 0);
    assert.deepEqual(removed, [ready.id]);
    await service.delete(ready.id);
    assert.throws(() => service.get(ready.id), /Document not found/);
    assert.equal(fs.readdirSync(uploadDir).length, 0);

    await assert.rejects(service.upload({
      originalName: 'bad.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from([0xff, 0xfe]),
      uploadedBy: 'admin-1',
    }), /UTF-8/);
    assert.equal(fs.readdirSync(uploadDir).length, 0, 'pre-validation rejection must not leave files');
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testActivationRollsBackWhenIndexRefreshFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-activation-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failIndexUpdate = false;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    removeDocumentFromIndex: () => {
      if (failIndexUpdate) throw new Error('index unavailable');
    },
  });

  try {
    const document = await service.upload({
      originalName: 'activation.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('启停一致性\n\n只有索引同步成功后才能完成状态切换。'),
      uploadedBy: 'admin-1',
    });
    failIndexUpdate = true;
    await assert.rejects(service.setActive(document.id, false), /index unavailable/);
    assert.equal(service.get(document.id).isActive, 1);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testTextUploadPublishesOnlyReadyChunks();
  await testFailureRetryLifecycleAndDuplicateProtection();
  await testActivationRollsBackWhenIndexRefreshFails();
  console.log('document RAG tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
