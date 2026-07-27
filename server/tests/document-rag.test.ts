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
  let publicationObservedPendingDatabase = false;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map((_, index) => [1, index + 1]),
    publishChunks: (chunks) => {
      published.push(chunks.map((chunk) => chunk.content));
      const stored = db.prepare(`
        SELECT status,
          (SELECT COUNT(*) FROM document_chunks WHERE document_id = documents.id) AS chunk_count
        FROM documents
        WHERE id = ?
      `).get(chunks[0].documentId) as { status: string; chunk_count: number };
      publicationObservedPendingDatabase = stored.status === 'pending' && stored.chunk_count === 0;
    },
  });

  try {
    const document = await service.upload({
      originalName: 'refund-policy.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('退款政策\n\n签收后七天内可以申请退款，并提供订单号。', 'utf8'),
      uploadedBy: 'admin-1',
    });

    assert.equal(document.status, 'ready', JSON.stringify(document));
    assert.equal(document.fileName, 'refund-policy.txt');
    assert.equal(document.chunkCount, 1);
    assert.equal(document.qualityDecision, 'ready');
    assert.equal(document.representationVersion, 'document-ir-v1');
    assert.equal(document.indexStatus, 'published');
    assert.equal('storagePath' in document, false, 'public document objects must not expose storage paths');

    const chunks = service.listChunks(document.id, { page: 1, pageSize: 20 });
    assert.equal(chunks.total, 1);
    assert.match(chunks.items[0].content, /七天内可以申请退款/);
    assert.deepEqual(chunks.items[0].sourceBlockIds, ['block-000001', 'block-000002']);
    assert.equal(chunks.items[0].chunkerVersion, 'structure-aware-v1');
    assert.deepEqual(published, [['退款政策\n\n签收后七天内可以申请退款，并提供订单号。']]);
    assert.equal(
      publicationObservedPendingDatabase,
      true,
      'new chunks must not become queryable in SQLite before index publication succeeds',
    );

    const detail = service.get(document.id);
    assert.equal(detail.representationSummary?.blockCount, 2);
    assert.deepEqual(detail.processingSummary?.stages.map((stage) => stage.name), [
      'validate',
      'parse',
      'normalize',
      'clean',
      'quality_gate',
      'chunk',
      'embed',
      'publish',
    ]);
    assert.ok(detail.processingSummary?.stages.every((stage) => stage.status === 'succeeded'));
    const blocks = service.listBlocks(document.id, { page: 1, pageSize: 1 });
    assert.equal(blocks.total, 2);
    assert.equal(blocks.items[0].kind, 'paragraph');

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

async function testLowQualityContentIsInspectableButNeverPublished(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-quality-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let publishCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => { publishCount += 1; },
  });

  try {
    const document = await service.upload({
      originalName: 'too-short.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Too short'),
      uploadedBy: 'admin-1',
    });
    assert.equal(document.status, 'failed');
    assert.equal(document.failureCode, 'quality_review_required');
    assert.equal(document.qualityDecision, 'review_required');
    assert.deepEqual(document.qualityReasons, ['near_empty_content']);
    assert.equal(document.chunkCount, 0);
    assert.equal(publishCount, 0);
    assert.equal(service.listBlocks(document.id, { page: 1, pageSize: 20 }).total, 1);
    assert.equal(service.get(document.id).processingSummary?.failureCode, 'quality_review_required');
    assert.deepEqual(service.get(document.id).processingSummary?.qualityReasons, ['near_empty_content']);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testUnsafeStructureRequiresReviewInsteadOfGenericFailure(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-structure-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let publishCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => { publishCount += 1; },
  });

  try {
    const document = await service.upload({
      originalName: 'unsafe-list.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(`- ${'x'.repeat(1_300)}`),
      uploadedBy: 'admin-1',
    });
    assert.equal(document.status, 'failed');
    assert.equal(document.failureCode, 'quality_review_required');
    assert.equal(document.qualityDecision, 'review_required');
    assert.deepEqual(document.qualityReasons, ['unsupported_structure']);
    assert.equal(document.indexStatus, 'failed');
    assert.equal(document.chunkCount, 0);
    assert.equal(publishCount, 0);
    assert.equal(
      service.get(document.id).processingSummary?.stages.find((stage) => stage.name === 'chunk')?.errorCode,
      'structural_unit_too_large',
    );
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testParserFailureDoesNotLeakRawCodesIntoQualityReasons(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-parser-failure-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
  });

  try {
    const document = await service.upload({
      originalName: 'broken.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-not-a-valid-document'),
      uploadedBy: 'admin-1',
    });
    assert.equal(document.status, 'failed');
    assert.equal(document.qualityDecision, 'rejected');
    assert.deepEqual(document.qualityReasons, []);
    assert.equal(document.failureCode, 'invalid_pdf');
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testReadyReprocessingKeepsPublishedStateWhenReplacementPublishFails(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-reprocess-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failPublish = false;
  let synchronizeCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => {
      if (failPublish) throw new Error('replacement index unavailable');
    },
    synchronizeIndex: () => { synchronizeCount += 1; },
  });

  try {
    const original = await service.upload({
      originalName: 'published.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Published policy\n\nThis content must remain searchable after a failed replacement.'),
      uploadedBy: 'admin-1',
    });
    const originalChunks = service.listChunks(original.id, { page: 1, pageSize: 20 }).items;
    const originalRepresentationId = service.get(original.id).representationSummary?.id;
    db.prepare(`
      UPDATE documents
      SET representation_version = NULL, cleaner_version = NULL, chunker_version = 'semantic-v1'
      WHERE id = ?
    `).run(original.id);

    failPublish = true;
    const afterFailure = await service.reprocess(original.id);
    assert.equal(afterFailure.status, 'ready');
    assert.equal(afterFailure.representationSummary?.id, originalRepresentationId);
    assert.equal(afterFailure.processingSummary?.status, 'failed');
    assert.equal(afterFailure.processingSummary?.failureCode, 'publish_failed');
    assert.equal(synchronizeCount, 1);
    assert.deepEqual(
      service.listChunks(original.id, { page: 1, pageSize: 20 }).items.map((chunk) => chunk.content),
      originalChunks.map((chunk) => chunk.content),
    );
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testUnknownIndexConvergenceDisablesShadowDocument(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-rag-index-unknown-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failPublish = false;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    publishChunks: () => {
      if (failPublish) throw new Error('index state unknown');
    },
  });

  try {
    const original = await service.upload({
      originalName: 'unknown-index.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Published source\n\nThis original content remains in the database.'),
      uploadedBy: 'admin-1',
    });
    db.prepare(`
      UPDATE documents
      SET representation_version = NULL, cleaner_version = NULL, chunker_version = 'semantic-v1'
      WHERE id = ?
    `).run(original.id);

    failPublish = true;
    const result = await service.reprocess(original.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.isActive, 0);
    assert.equal(result.indexStatus, 'failed');
    assert.equal(result.processingSummary?.failureCode, 'publish_failed');
    assert.ok(service.listChunks(original.id, { page: 1, pageSize: 20 }).total > 0);
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
  const buffer = Buffer.from('物流政策\n\n包裹通常三个工作日送达，如有延迟请联系人工客服。');

  try {
    const failed = await service.upload({
      originalName: 'shipping.md',
      mimeType: 'text/markdown',
      buffer,
      uploadedBy: 'admin-1',
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'embedding_failed');
    assert.equal(service.listChunks(failed.id, { page: 1, pageSize: 20 }).total, 0);
    assert.equal(fs.readdirSync(uploadDir).length, 1, 'accepted failed uploads remain available for retry');
    await assert.rejects(service.setActive(failed.id, false), /Only ready documents/);

    const missingSource = await service.upload({
      originalName: 'missing-source.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Missing source retry\n\nThis document records a failed validation stage.'),
      uploadedBy: 'admin-1',
    });
    const storedPath = (db.prepare('SELECT storage_path AS storagePath FROM documents WHERE id = ?')
      .get(missingSource.id) as { storagePath: string }).storagePath;
    fs.unlinkSync(path.join(uploadDir, storedPath));
    const missingRetry = await service.retry(missingSource.id);
    assert.equal(missingRetry.failureCode, 'source_file_missing');
    assert.equal(service.get(missingSource.id).processingSummary?.retryOf, missingSource.latestTaskId);
    assert.deepEqual(service.get(missingSource.id).processingSummary?.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      errorCode: stage.errorCode,
    })), [{
      name: 'validate',
      status: 'failed',
      errorCode: 'source_file_missing',
    }]);

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
      buffer: Buffer.from('删除一致性\n\n索引失败时必须保留原始状态，并等待安全恢复。'),
      uploadedBy: 'admin-1',
    });
    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.equal(service.get(document.id).status, 'ready');
    assert.equal(service.get(document.id).representationSummary?.schemaVersion, 'document-ir-v1');
    assert.equal(service.get(document.id).processingSummary?.status, 'succeeded');
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

async function testDeleteRollsBackDatabaseWhenFileRemovalFails(): Promise<void> {
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
    let failedRemoval = false;
    fs.rmSync = ((target, options) => {
      if (!failedRemoval && String(target).endsWith('.deleting')) {
        failedRemoval = true;
        throw new Error('simulated file removal failure');
      }
      return originalRmSync(target, options as Parameters<typeof fs.rmSync>[1]);
    }) as typeof fs.rmSync;

    await assert.rejects(service.delete(document.id), /could not be completed/);
    assert.equal(service.get(document.id).status, 'ready');
    assert.equal(publishCount, 2, 'the preserved database record should restore its index state');
    assert.equal(fs.readdirSync(uploadDir).filter((name) => name.endsWith('.txt')).length, 1);
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
      buffer: Buffer.from('文件补偿\n\n原文件恢复失败时文档必须停用并等待人工处理。'),
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
  await testLowQualityContentIsInspectableButNeverPublished();
  await testUnsafeStructureRequiresReviewInsteadOfGenericFailure();
  await testParserFailureDoesNotLeakRawCodesIntoQualityReasons();
  await testReadyReprocessingKeepsPublishedStateWhenReplacementPublishFails();
  await testUnknownIndexConvergenceDisablesShadowDocument();
  await testFailureRetryLifecycleAndDuplicateProtection();
  await testActivationRollsBackWhenIndexRefreshFails();
  await testDeleteRestoresFileAndDatabaseWhenIndexRemovalFails();
  await testDeleteRollsBackDatabaseWhenFileRemovalFails();
  await testDeleteKeepsSourceWhenFinalDatabaseRemovalFails();
  await testDeleteDisablesDocumentWhenFileRollbackFails();
  await testDeleteRestoresRecordWhenIndexConvergenceFails();
  console.log('document RAG tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
