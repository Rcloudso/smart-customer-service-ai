import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import {
  OCR_EXTRACTION_CONTRACT_VERSION,
  OcrExtractionResult,
} from '../ai/ocr-contract';
import {
  OcrExtractionError,
  OcrExtractor,
} from '../ai/ocr-extractor';
import { DocumentReviewRepo } from '../db/repos/document-review.repo';
import { DocumentService } from '../services/document.service';
import { ConflictError } from '../utils/errors';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('resolve-weave-ocr-fixture'),
]);
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('resolve-weave-ocr-fixture-jpeg'),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('resolve-weave-ocr-fixture-webp'),
]);

function extractedResult(): OcrExtractionResult {
  return {
    contractVersion: OCR_EXTRACTION_CONTRACT_VERSION,
    engine: {
      name: 'paddleocr_ppstructurev3',
      version: '3.0.0',
    },
    blocks: [
      {
        id: 'block-000001',
        order: 0,
        kind: 'heading',
        pageNumber: 1,
        headingPath: ['退款政策'],
        confidence: 0.99,
        layout: { x: 12, y: 16, width: 180, height: 24 },
        excluded: false,
        exclusionReason: null,
        level: 1,
        text: '退款政策',
      },
      {
        id: 'block-000002',
        order: 1,
        kind: 'paragraph',
        pageNumber: 1,
        headingPath: ['退款政策'],
        confidence: 0.94,
        layout: { x: 12, y: 52, width: 500, height: 80 },
        excluded: false,
        exclusionReason: null,
        text: '签收后七天内可以申请退款，并提供订单号。',
      },
    ],
    warnings: [],
    metrics: {
      pageCount: 1,
      blockCount: 2,
      elapsedMs: 24,
    },
  };
}

class FakePaddleExtractor implements OcrExtractor {
  readonly engine = 'paddleocr_ppstructurev3';
  readonly engineVersion = '3.0.0';
  fail = false;
  calls = 0;

  async extract(): Promise<OcrExtractionResult> {
    this.calls += 1;
    if (this.fail) throw new OcrExtractionError('ocr_worker_unavailable');
    return extractedResult();
  }
}

async function testVisualUploadCreatesReviewDraftWithoutPublishing(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-ready-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const extractor = new FakePaddleExtractor();
  let embedCount = 0;
  let publishCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    authoritativeOcr: extractor,
    embedTexts: async () => {
      embedCount += 1;
      return [];
    },
    publishChunks: () => {
      publishCount += 1;
    },
  });

  try {
    const document = await service.upload({
      originalName: 'refund-policy.png',
      mimeType: 'image/png',
      buffer: png,
      uploadedBy: 'admin',
    });
    assert.equal(document.format, 'png');
    assert.equal(document.status, 'failed');
    assert.equal(document.failureCode, 'ocr_review_required');
    assert.equal(document.qualityDecision, 'review_required');
    assert.deepEqual(document.qualityReasons, ['ocr_review_required']);
    assert.equal(document.indexStatus, 'not_indexed');
    assert.equal(extractor.calls, 1);
    assert.equal(embedCount, 0);
    assert.equal(publishCount, 0);

    const raw = db.prepare(`
      SELECT format, source_format AS sourceFormat FROM documents WHERE id = ?
    `).get(document.id) as { format: string; sourceFormat: string };
    assert.equal(raw.format, 'txt', 'legacy format column must remain compatible');
    assert.equal(raw.sourceFormat, 'png');

    const detail = service.get(document.id);
    assert.equal(detail.extractionSummary?.status, 'succeeded');
    assert.equal(detail.extractionSummary?.engine, 'paddleocr_ppstructurev3');
    assert.equal(detail.extractionSummary?.blockCount, 2);
    assert.equal(detail.reviewDraftSummary?.status, 'open');
    assert.equal(detail.reviewDraftSummary?.revision, 1);
    assert.equal(detail.reviewDraftSummary?.blockCount, 2);

    const draft = service.listReviewDraftBlocks(document.id, { page: 1, pageSize: 1 });
    assert.equal(draft.total, 2);
    assert.equal(draft.items.length, 1);
    assert.equal(draft.items[0].kind, 'heading');
    assert.equal(draft.items[0].manuallyEdited, false);
    const secondDraftPage = service.listReviewDraftBlocks(
      document.id,
      { page: 2, pageSize: 1 },
    );
    assert.equal(secondDraftPage.items[0].kind, 'paragraph');
    assert.equal(service.listChunks(document.id, { page: 1, pageSize: 20 }).total, 0);

    assert.deepEqual(fs.readdirSync(uploadDir), [`${document.id}.png`]);
    await assert.rejects(service.upload({
      originalName: 'forged.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not-a-png'),
      uploadedBy: 'admin',
    }), /PNG signature is invalid/);

    const webpDocument = await service.upload({
      originalName: 'shipping-policy.webp',
      mimeType: 'image/webp',
      buffer: webp,
      uploadedBy: 'admin',
    });
    assert.equal(webpDocument.format, 'webp');
    assert.equal(webpDocument.failureCode, 'ocr_review_required');
    assert.equal(extractor.calls, 2);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testFailedVisualExtractionCanRetryIntoReview(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-retry-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const extractor = new FakePaddleExtractor();
  extractor.fail = true;
  const service = new DocumentService(db, {
    uploadDir,
    authoritativeOcr: extractor,
    embedTexts: async () => [],
  });

  try {
    const failed = await service.upload({
      originalName: 'refund-policy.jpg',
      mimeType: 'image/jpeg',
      buffer: jpeg,
      uploadedBy: 'admin',
    });
    assert.equal(failed.format, 'jpeg');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'ocr_worker_unavailable');
    assert.equal(service.get(failed.id).extractionSummary?.status, 'failed');
    const failedJobId = service.get(failed.id).extractionSummary?.jobId;

    extractor.fail = false;
    const retried = await service.retry(failed.id);
    assert.equal(retried.failureCode, 'ocr_review_required');
    const detail = service.get(failed.id);
    assert.equal(detail.extractionSummary?.status, 'succeeded');
    assert.equal(detail.extractionSummary?.retryOf, failedJobId);
    assert.equal(detail.reviewDraftSummary?.revision, 1);
    assert.equal(extractor.calls, 2);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testVisualUploadWithoutWorkerFailsSafely(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-unconfigured-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let publishCount = 0;
  const service = new DocumentService(db, {
    uploadDir,
    embedTexts: async () => {
      throw new Error('visual uploads must not call embeddings without an OCR worker');
    },
    publishChunks: () => {
      publishCount += 1;
    },
  });

  try {
    const document = await service.upload({
      originalName: 'refund-policy.png',
      mimeType: 'image/png',
      buffer: png,
      uploadedBy: 'admin',
    });
    assert.equal(document.status, 'failed');
    assert.equal(document.failureCode, 'ocr_worker_unconfigured');
    assert.equal(document.indexStatus, 'not_indexed');
    assert.equal(service.get(document.id).extractionSummary, null);
    assert.equal(service.get(document.id).reviewDraftSummary, null);
    assert.equal(service.listChunks(document.id, { page: 1, pageSize: 20 }).total, 0);
    assert.equal(publishCount, 0);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testReviewedDraftPublishesWholeDocument(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-publish-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const extractor = new FakePaddleExtractor();
  let publishedContents: string[] = [];
  const service = new DocumentService(db, {
    uploadDir,
    authoritativeOcr: extractor,
    embedTexts: async (texts) => texts.map((text) => [text.length, 1]),
    publishChunks: (chunks) => {
      publishedContents = chunks.map((chunk) => chunk.content);
    },
  });

  try {
    const document = await service.upload({
      originalName: 'reviewed-refund-policy.png',
      mimeType: 'image/png',
      buffer: png,
      uploadedBy: 'admin',
    });
    const draft = service.listReviewDraftBlocks(document.id, { page: 1, pageSize: 100 });
    const editedBlocks = draft.items.map(({ manuallyEdited: _manuallyEdited, ...block }) => (
      block.kind === 'paragraph'
        ? { ...block, text: '签收后七个自然日内可以申请退款，并提供订单号。' }
        : block
    ));

    const updated = service.updateReviewDraft(
      document.id,
      draft.revision as number,
      editedBlocks,
      'reviewer',
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.items[1].manuallyEdited, true);
    assert.throws(
      () => service.updateReviewDraft(document.id, 1, editedBlocks, 'reviewer'),
      ConflictError,
    );
    await assert.rejects(
      service.publishReviewDraft(document.id, 1),
      ConflictError,
    );
    assert.equal([...publishedContents].length, 0);

    const published = await service.publishReviewDraft(document.id, 2);
    assert.equal(published.status, 'ready');
    assert.equal(published.failureCode, null);
    assert.equal(published.indexStatus, 'published');
    assert.equal(published.qualityDecision, 'ready');
    assert.equal(published.reviewDraftSummary?.status, 'published');
    assert.equal(published.reviewDraftSummary?.revision, 2);
    assert.ok(published.chunkCount > 0);
    assert.ok(publishedContents.some((content) => content.includes('七个自然日')));
    const chunks = service.listChunks(document.id, { page: 1, pageSize: 20 });
    assert.ok(chunks.items.some((chunk) => (
      chunk.content.includes('七个自然日')
      && chunk.sourceBlockIds?.includes('block-000002')
      && chunk.pageStart === 1
    )));
    const immutableResult = db.prepare(`
      SELECT result_json AS resultJson
      FROM document_extraction_jobs
      WHERE document_id = ? AND role = 'authoritative'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(document.id) as { resultJson: string };
    assert.match(immutableResult.resultJson, /签收后七天内可以申请退款/);
    assert.doesNotMatch(immutableResult.resultJson, /七个自然日/);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testPublishFailureLeavesDraftOpenAndUnindexed(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-publish-failure-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const service = new DocumentService(db, {
    uploadDir,
    authoritativeOcr: new FakePaddleExtractor(),
    embedTexts: async (texts) => texts.map((text) => [text.length, 1]),
    publishChunks: () => {
      throw new Error('simulated index failure');
    },
  });

  try {
    const document = await service.upload({
      originalName: 'publish-failure.png',
      mimeType: 'image/png',
      buffer: png,
      uploadedBy: 'admin',
    });
    const result = await service.publishReviewDraft(document.id, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'publish_failed');
    assert.equal(result.indexStatus, 'failed');
    assert.equal(result.reviewDraftSummary?.status, 'open');
    assert.equal(service.listChunks(document.id, { page: 1, pageSize: 20 }).total, 0);
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function testReplacementFailurePreservesPublishedKnowledge(): Promise<void> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-ocr-replacement-failure-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  let failPublication = false;
  const service = new DocumentService(db, {
    uploadDir,
    authoritativeOcr: new FakePaddleExtractor(),
    embedTexts: async (texts) => texts.map((text) => [text.length, 1]),
    publishChunks: () => {
      if (failPublication) throw new Error('simulated replacement index failure');
    },
    synchronizeIndex: async () => {},
  });

  try {
    const document = await service.upload({
      originalName: 'replacement-policy.png',
      mimeType: 'image/png',
      buffer: png,
      uploadedBy: 'admin',
    });
    const firstPublication = await service.publishReviewDraft(document.id, 1);
    assert.equal(firstPublication.status, 'ready');
    const publishedChunks = service.listChunks(
      document.id,
      { page: 1, pageSize: 20 },
    ).items.map((chunk) => chunk.content);

    const reviewRepo = new DocumentReviewRepo(db);
    const replacementJob = reviewRepo.createExtractionJob({
      documentId: document.id,
      sourceVersion: 1,
      role: 'authoritative',
      engine: 'paddleocr_ppstructurev3',
      engineVersion: '3.0.0',
    });
    reviewRepo.startExtractionJob(replacementJob.id);
    reviewRepo.completeExtractionJob(replacementJob.id, extractedResult());
    reviewRepo.createDraftFromAuthoritativeJob(replacementJob.id, 'reviewer');

    failPublication = true;
    const failedReplacement = await service.publishReviewDraft(document.id, 1);
    assert.equal(failedReplacement.status, 'ready');
    assert.equal(failedReplacement.failureCode, null);
    assert.equal(failedReplacement.indexStatus, 'published');
    assert.equal(failedReplacement.reviewDraftSummary?.status, 'open');
    assert.deepEqual(
      service.listChunks(document.id, { page: 1, pageSize: 20 })
        .items.map((chunk) => chunk.content),
      publishedChunks,
    );
  } finally {
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testVisualUploadCreatesReviewDraftWithoutPublishing();
  await testFailedVisualExtractionCanRetryIntoReview();
  await testVisualUploadWithoutWorkerFailsSafely();
  await testReviewedDraftPublishesWholeDocument();
  await testPublishFailureLeavesDraftOpenAndUnindexed();
  await testReplacementFailurePreservesPublishedKnowledge();
  console.log('document OCR tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
