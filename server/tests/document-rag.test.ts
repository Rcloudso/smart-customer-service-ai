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
    assert.equal(fs.statSync(uploadDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(uploadDir, storedFiles[0])).mode & 0o777, 0o600);
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

async function testDeleteRestoresFileAndDatabaseWhenIndexRemovalFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-delete-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failRemoval = true;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    removeDocumentFromIndex: () => {
      if (failRemoval) throw new Error('index removal failed');
    },
  });

  try {
    const document = await service.upload({
      originalName: 'delete.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('删除一致性\n\n索引失败时必须保留原始状态。'),
      uploadedBy: 'admin-1',
    });
    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.equal(service.get(document.id).status, 'ready');
    assert.equal(fs.readdirSync(uploadDir).filter((name) => name.endsWith('.txt')).length, 1);
    assert.equal(fs.readdirSync(uploadDir).some((name) => name.endsWith('.deleting')), false);

    failRemoval = false;
    await service.delete(document.id);
    assert.throws(() => service.get(document.id), /Document not found/);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testDeleteDoesNotRepublishWhenDatabaseCompensationFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-delete-compensation-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let publishCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => { publishCount += 1; },
  });
  const originalRmSync = fs.rmSync;

  try {
    const document = await service.upload({
      originalName: 'compensation.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('补偿失败\n\n数据库恢复失败时不能重新发布孤立索引。'),
      uploadedBy: 'admin-1',
    });
    db.exec("CREATE TRIGGER block_document_restore BEFORE INSERT ON documents WHEN NEW.id = '" + document.id
      + "' BEGIN SELECT RAISE(FAIL, 'restore blocked'); END;");
    let failedRemoval = false;
    fs.rmSync = ((target, options) => {
      if (!failedRemoval && String(target).endsWith('.deleting')) {
        failedRemoval = true;
        throw new Error('simulated file removal failure');
      }
      return originalRmSync(target, options as Parameters<typeof fs.rmSync>[1]);
    }) as typeof fs.rmSync;

    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.throws(() => service.get(document.id), /Document not found/);
    assert.equal(publishCount, 1, 'failed database restore must not republish orphan chunks');
    assert.equal(fs.readdirSync(uploadDir).length, 0);
  } finally {
    fs.rmSync = originalRmSync;
    db.close();
    originalRmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testDeleteKeepsSourceWhenFinalDatabaseRemovalFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-delete-final-db-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failPublish = false;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => {
      if (!failPublish) return;
      db.exec("CREATE TRIGGER block_final_document_delete BEFORE DELETE ON documents "
        + "BEGIN SELECT RAISE(FAIL, 'delete blocked'); END;");
      throw new Error('simulated index rollback failure');
    },
  });
  const originalRmSync = fs.rmSync;

  try {
    const document = await service.upload({
      originalName: 'final-db-failure.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('最终收敛\n\n数据库无法删除时必须保留原文件并停用文档。'),
      uploadedBy: 'admin-1',
    });
    failPublish = true;
    let failedRemoval = false;
    fs.rmSync = ((target, options) => {
      if (!failedRemoval && String(target).endsWith('.deleting')) {
        failedRemoval = true;
        throw new Error('simulated file removal failure');
      }
      return originalRmSync(target, options as Parameters<typeof fs.rmSync>[1]);
    }) as typeof fs.rmSync;

    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.equal(service.get(document.id).isActive, 0);
    assert.equal(fs.readdirSync(uploadDir).filter((name) => name.endsWith('.txt')).length, 1);
    assert.equal(fs.readdirSync(uploadDir).some((name) => name.endsWith('.deleting')), false);
  } finally {
    fs.rmSync = originalRmSync;
    db.close();
    originalRmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testDeleteDisablesDocumentWhenFileRollbackFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-delete-file-rollback-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const removed: string[] = [];
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    removeDocumentFromIndex: (documentId) => { removed.push(documentId); },
  });
  const originalRenameSync = fs.renameSync;

  try {
    const document = await service.upload({
      originalName: 'file-rollback.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('文件补偿\n\n原文件恢复失败时文档必须停用。'),
      uploadedBy: 'admin-1',
    });
    let triggerCreated = false;
    fs.renameSync = ((oldPath, newPath) => {
      if (String(oldPath).endsWith('.deleting')) {
        if (!triggerCreated) {
          triggerCreated = true;
          db.exec("CREATE TRIGGER block_file_rollback_delete BEFORE DELETE ON documents "
            + "BEGIN SELECT RAISE(FAIL, 'delete blocked'); END;");
        }
        throw new Error('simulated file rollback failure');
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;

    const originalRmSync = fs.rmSync;
    let failedRemoval = false;
    fs.rmSync = ((target, options) => {
      if (!failedRemoval && String(target).endsWith('.deleting')) {
        failedRemoval = true;
        throw new Error('simulated file removal failure');
      }
      return originalRmSync(target, options as Parameters<typeof fs.rmSync>[1]);
    }) as typeof fs.rmSync;
    try {
      await assert.rejects(service.delete(document.id), /could not be completed/);
    } finally {
      fs.rmSync = originalRmSync;
    }
    assert.equal(service.get(document.id).isActive, 0);
    assert.ok(removed.includes(document.id));
    assert.equal(fs.readdirSync(uploadDir).some((name) => name.endsWith('.deleting')), true);
  } finally {
    fs.renameSync = originalRenameSync;
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testDeleteRestoresRecordWhenIndexConvergenceFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-delete-index-convergence-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let syncAttempts = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    synchronizeIndex: () => {
      syncAttempts += 1;
      if (syncAttempts <= 3) throw new Error('simulated full index sync failure');
    },
  });

  try {
    const document = await service.upload({
      originalName: 'index-convergence.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('索引收敛\n\n索引清理失败时必须恢复可重试记录。'),
      uploadedBy: 'admin-1',
    });
    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.equal(service.get(document.id).status, 'ready');
    assert.equal(service.get(document.id).isActive, 1);
    assert.equal(fs.readdirSync(uploadDir).filter((name) => name.endsWith('.txt')).length, 1);
    assert.equal(fs.readdirSync(uploadDir).some((name) => name.endsWith('.deleting')), false);
    assert.equal(syncAttempts, 4);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testTextUploadPublishesOnlyReadyChunks();
  await testFailureRetryLifecycleAndDuplicateProtection();
  await testActivationRollsBackWhenIndexRefreshFails();
  await testDeleteRestoresFileAndDatabaseWhenIndexRemovalFails();
  await testDeleteDoesNotRepublishWhenDatabaseCompensationFails();
  await testDeleteKeepsSourceWhenFinalDatabaseRemovalFails();
  await testDeleteDisablesDocumentWhenFileRollbackFails();
  await testDeleteRestoresRecordWhenIndexConvergenceFails();
  console.log('document RAG tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
