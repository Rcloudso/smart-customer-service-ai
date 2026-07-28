import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';
import {
  DocumentReviewConflictError,
  DocumentReviewRepo,
} from '../db/repos/document-review.repo';
import {
  OCR_EXTRACTION_CONTRACT_VERSION,
  validateOcrExtractionResult,
} from '../ai/ocr-contract';
import {
  HttpOcrExtractor,
  OcrExtractionError,
} from '../ai/ocr-extractor';

const extracted = validateOcrExtractionResult({
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
      layout: { x: 10, y: 12, width: 180, height: 24 },
      excluded: false,
      exclusionReason: null,
      level: 1,
      text: '退款政策',
    },
    {
      id: 'block-000002',
      order: 1,
      kind: 'table',
      pageNumber: 1,
      headingPath: ['退款政策'],
      confidence: 0.91,
      layout: { x: 10, y: 50, width: 600, height: 240 },
      excluded: false,
      exclusionReason: null,
      rowCount: 2,
      columnCount: 2,
      cells: [
        {
          rowIndex: 0,
          columnIndex: 0,
          rowSpan: 1,
          columnSpan: 1,
          text: '条件',
          isHeader: true,
        },
        {
          rowIndex: 0,
          columnIndex: 1,
          rowSpan: 1,
          columnSpan: 1,
          text: '时限',
          isHeader: true,
        },
        {
          rowIndex: 1,
          columnIndex: 0,
          rowSpan: 1,
          columnSpan: 1,
          text: '签收后',
          isHeader: false,
        },
        {
          rowIndex: 1,
          columnIndex: 1,
          rowSpan: 1,
          columnSpan: 1,
          text: '七天',
          isHeader: false,
        },
      ],
    },
  ],
  warnings: [],
  metrics: {
    pageCount: 1,
    blockCount: 2,
    elapsedMs: 42,
  },
});

function createDocument(db: Database.Database): string {
  const repo = new DocumentRepo(db);
  return repo.createPending({
    id: '11111111-1111-4111-8111-111111111111',
    fileName: 'scan.pdf',
    storagePath: 'scan.pdf',
    format: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 128,
    sha256: 'a'.repeat(64),
    uploadedBy: 'admin',
  }).id;
}

async function testHttpExtractor(): Promise<void> {
  let requestBody: Record<string, unknown> | null = null;
  const extractor = new HttpOcrExtractor({
    baseUrl: 'http://127.0.0.1:8765/',
    token: 'worker-secret',
    engine: 'paddleocr_ppstructurev3',
    engineVersion: '3.0.0',
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:8765/v1/extractions');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer worker-secret');
      requestBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ code: 0, data: extracted, message: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await extractor.extract({
    requestId: 'request-1',
    documentId: '11111111-1111-4111-8111-111111111111',
    sourceVersion: 1,
    fileName: 'scan.png',
    mimeType: 'image/png',
    sha256: 'b'.repeat(64),
    buffer: Buffer.from('image-bytes'),
  });
  assert.equal(result.engine.name, 'paddleocr_ppstructurev3');
  assert.ok(requestBody);
  const capturedRequestBody = requestBody as unknown as {
    source: { contentBase64: string };
  };
  assert.equal(
    capturedRequestBody.source.contentBase64,
    Buffer.from('image-bytes').toString('base64'),
  );

  const mismatched = new HttpOcrExtractor({
    baseUrl: 'http://127.0.0.1:8765',
    engine: 'deepseek_ocr2',
    engineVersion: '2.0.0',
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0,
      data: extracted,
    }), { status: 200 }),
  });
  await assert.rejects(
    mismatched.extract({
      requestId: 'request-2',
      documentId: '11111111-1111-4111-8111-111111111111',
      sourceVersion: 1,
      fileName: 'scan.png',
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      buffer: Buffer.from('image-bytes'),
    }),
    (error: unknown) => (
      error instanceof OcrExtractionError
      && error.failureCode === 'ocr_worker_engine_mismatch'
    ),
  );
}

async function main(): Promise<void> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  initSchema(db);
  const documentId = createDocument(db);
  const repo = new DocumentReviewRepo(db);

  const job = repo.createExtractionJob({
    documentId,
    sourceVersion: 1,
    role: 'authoritative',
    engine: 'paddleocr_ppstructurev3',
    engineVersion: '3.0.0',
  });
  assert.equal(job.status, 'queued');
  repo.startExtractionJob(job.id);
  const completed = repo.completeExtractionJob(job.id, extracted);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result?.blocks.length, 2);

  const draft = repo.createDraftFromAuthoritativeJob(job.id, 'admin');
  assert.equal(draft.revision, 1);
  assert.equal(draft.status, 'open');
  assert.equal(draft.blocks.length, 2);
  assert.equal(draft.blocks[1].manuallyEdited, false);
  db.prepare(`
    UPDATE document_review_blocks SET payload = ?
    WHERE draft_id = ? AND block_id = ?
  `).run('{malformed', draft.id, 'block-000001');
  const recoveredDraft = repo.getDraft(draft.id);
  assert.ok(recoveredDraft);
  assert.equal(recoveredDraft.blocks[0].kind, 'heading');
  assert.equal(recoveredDraft.blocks[0].confidence, 0);
  assert.equal(
    recoveredDraft.blocks[0].exclusionReason,
    'malformed_historical_payload',
  );
  assert.throws(
    () => repo.replaceDraftBlocks(
      draft.id,
      1,
      recoveredDraft.blocks.map(({ manuallyEdited: _manuallyEdited, ...block }) => block),
      'reviewer',
    ),
    DocumentReviewConflictError,
  );
  assert.throws(
    () => repo.publishDraft(draft.id, 1, () => {}),
    DocumentReviewConflictError,
  );
  db.prepare(`
    UPDATE document_review_blocks SET payload = ?
    WHERE draft_id = ? AND block_id = ?
  `).run(JSON.stringify(extracted.blocks[0]), draft.id, 'block-000001');

  const editedBlocks = draft.blocks.map(({ manuallyEdited: _manuallyEdited, ...block }) => (
    block.kind === 'table'
      ? {
        ...block,
        cells: block.cells.map((cell) => (
          cell.rowIndex === 1 && cell.columnIndex === 1
            ? { ...cell, text: '七个自然日' }
            : cell
        )),
      }
      : block
  ));
  const updated = repo.replaceDraftBlocks(draft.id, 1, editedBlocks, 'reviewer');
  assert.equal(updated.revision, 2);
  assert.equal(updated.blocks[1].manuallyEdited, true);
  assert.equal(
    updated.blocks[1].kind === 'table' ? updated.blocks[1].cells.at(-1)?.text : '',
    '七个自然日',
  );
  const originalExtractedBlock = repo.getExtractionJob(job.id)?.result?.blocks[1];
  assert.equal(
    originalExtractedBlock?.kind === 'table'
      ? originalExtractedBlock.cells.at(-1)?.text
      : '',
    '七天',
    'draft edits must not mutate immutable extractor output',
  );
  assert.throws(
    () => repo.replaceDraftBlocks(draft.id, 1, editedBlocks, 'reviewer'),
    DocumentReviewConflictError,
  );

  db.exec('CREATE TABLE publication_probe (value TEXT NOT NULL)');
  assert.throws(() => repo.publishDraft(draft.id, 2, () => {
    db.prepare('INSERT INTO publication_probe (value) VALUES (?)').run('partial');
    throw new Error('simulated publication failure');
  }), /simulated publication failure/);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS total FROM publication_probe').get() as { total: number }).total,
    0,
  );
  assert.equal(repo.getDraft(draft.id)?.status, 'open');

  const published = repo.publishDraft(draft.id, 2, (blocks) => {
    assert.equal(blocks.length, 2);
    db.prepare('INSERT INTO publication_probe (value) VALUES (?)').run('complete');
  });
  assert.equal(published.status, 'published');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS total FROM publication_probe').get() as { total: number }).total,
    1,
  );

  const shadowJob = repo.createExtractionJob({
    documentId,
    sourceVersion: 1,
    role: 'shadow',
    engine: 'deepseek_ocr2',
    engineVersion: '2.0.0',
  });
  repo.startExtractionJob(shadowJob.id);
  repo.completeExtractionJob(shadowJob.id, validateOcrExtractionResult({
    ...extracted,
    engine: { name: 'deepseek_ocr2', version: '2.0.0' },
  }));
  assert.throws(
    () => repo.createDraftFromAuthoritativeJob(shadowJob.id, 'admin'),
    /authoritative/,
  );
  assert.throws(() => repo.createExtractionJob({
    documentId,
    sourceVersion: 1,
    role: 'authoritative',
    engine: 'deepseek_ocr2',
    engineVersion: '2.0.0',
  }), /not allowed/);

  assert.throws(() => validateOcrExtractionResult({
    ...extracted,
    blocks: [...extracted.blocks].reverse(),
  }), /invalid_ocr_result/);
  assert.equal(validateOcrExtractionResult({
    ...extracted,
    metrics: { ...extracted.metrics, pageCount: 2 },
  }).metrics.pageCount, 2);

  db.close();
  await testHttpExtractor();
  console.log('OCR review contract tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
