import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { DocumentBlock, documentBlockSchema } from '../../ai/document-ir';
import {
  OcrEngineName,
  OcrExtractionResult,
  validateOcrDraftBlocks,
  validateOcrExtractionResult,
} from '../../ai/ocr-contract';

export type OcrExtractionRole = 'authoritative' | 'shadow';
export type OcrExtractionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type DocumentReviewDraftStatus = 'open' | 'published' | 'superseded';

export interface OcrExtractionJob {
  id: string;
  documentId: string;
  sourceVersion: number;
  role: OcrExtractionRole;
  engine: OcrEngineName;
  engineVersion: string;
  status: OcrExtractionJobStatus;
  retryOf: string | null;
  result: OcrExtractionResult | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type OcrExtractionJobSummaryRecord = OcrExtractionJob & {
  summaryBlockCount: number;
  summaryWarningCodes: string[];
};

export type DocumentReviewBlock = DocumentBlock & {
  manuallyEdited: boolean;
};

export interface DocumentReviewDraft {
  id: string;
  documentId: string;
  sourceJobId: string;
  revision: number;
  status: DocumentReviewDraftStatus;
  blocks: DocumentReviewBlock[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface DocumentReviewDraftSummaryRecord {
  id: string;
  revision: number;
  status: DocumentReviewDraftStatus;
  blockCount: number;
  manuallyEditedBlockCount: number;
  updatedBy: string;
  updatedAt: string;
  publishedAt: string | null;
}

export class DocumentReviewRepo {
  constructor(private readonly db: Database.Database) {}

  createExtractionJob(params: {
    documentId: string;
    sourceVersion: number;
    role: OcrExtractionRole;
    engine: OcrEngineName;
    engineVersion: string;
    retryOf?: string | null;
  }): OcrExtractionJob {
    assertEngineRole(params.role, params.engine);
    if (
      !Number.isInteger(params.sourceVersion)
      || params.sourceVersion < 1
      || !params.engineVersion.trim()
      || params.engineVersion.length > 80
    ) {
      throw new Error('Extraction job metadata is invalid');
    }
    if (params.retryOf) {
      const retryOf = this.requireExtractionJob(params.retryOf);
      if (
        retryOf.documentId !== params.documentId
        || retryOf.role !== params.role
        || retryOf.engine !== params.engine
        || !['failed', 'succeeded'].includes(retryOf.status)
      ) {
        throw new DocumentReviewConflictError('Extraction retry target is incompatible');
      }
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO document_extraction_jobs (
        id, document_id, source_version, role, engine, engine_version, status,
        retry_of, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      params.documentId,
      params.sourceVersion,
      params.role,
      params.engine,
      params.engineVersion.trim(),
      params.retryOf ?? null,
      now,
    );
    return this.requireExtractionJob(id);
  }

  startExtractionJob(id: string): OcrExtractionJob {
    const result = this.db.prepare(`
      UPDATE document_extraction_jobs
      SET status = 'running', started_at = ?, completed_at = NULL,
          result_json = NULL, result_block_count = 0,
          result_warning_codes = '[]', error_code = NULL
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new DocumentReviewConflictError('Extraction job is not queued');
    }
    return this.requireExtractionJob(id);
  }

  completeExtractionJob(id: string, input: unknown): OcrExtractionJob {
    const job = this.requireExtractionJob(id);
    const result = validateOcrExtractionResult(input);
    if (
      job.status !== 'running'
      || result.engine.name !== job.engine
      || result.engine.version !== job.engineVersion
    ) {
      throw new DocumentReviewConflictError('Extraction result does not match the running job');
    }
    const updated = this.db.prepare(`
      UPDATE document_extraction_jobs
      SET status = 'succeeded', result_json = ?, result_block_count = ?,
          result_warning_codes = ?, error_code = NULL, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      JSON.stringify(result),
      result.blocks.length,
      JSON.stringify(result.warnings.map((warning) => warning.code)),
      new Date().toISOString(),
      id,
    );
    if (updated.changes !== 1) {
      throw new DocumentReviewConflictError('Extraction job is not running');
    }
    return this.requireExtractionJob(id);
  }

  failExtractionJob(id: string, errorCode: string): OcrExtractionJob {
    if (!/^[a-z][a-z0-9_]{0,119}$/.test(errorCode)) {
      throw new Error('Invalid extraction error code');
    }
    const updated = this.db.prepare(`
      UPDATE document_extraction_jobs
      SET status = 'failed', result_json = NULL, result_block_count = 0,
          result_warning_codes = '[]', error_code = ?, completed_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(errorCode, new Date().toISOString(), id);
    if (updated.changes !== 1) {
      throw new DocumentReviewConflictError('Extraction job is already complete');
    }
    return this.requireExtractionJob(id);
  }

  getExtractionJob(id: string): OcrExtractionJob | null {
    const row = this.db.prepare(`
      SELECT * FROM document_extraction_jobs WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? mapExtractionJob(row) : null;
  }

  findLatestExtractionJob(
    documentId: string,
    role: OcrExtractionRole = 'authoritative',
  ): OcrExtractionJob | null {
    const row = this.db.prepare(`
      SELECT * FROM document_extraction_jobs
      WHERE document_id = ? AND role = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(documentId, role) as Record<string, unknown> | undefined;
    return row ? mapExtractionJob(row) : null;
  }

  listExtractionJobSummaries(
    documentId: string,
    limit = 20,
  ): OcrExtractionJobSummaryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Extraction job list limit is invalid');
    }
    const rows = this.db.prepare(`
      SELECT jobs.id, jobs.document_id, jobs.source_version, jobs.role,
             jobs.engine, jobs.engine_version, jobs.status, jobs.retry_of,
             jobs.error_code, jobs.created_at, jobs.started_at, jobs.completed_at,
             jobs.result_block_count AS summary_block_count,
             jobs.result_warning_codes AS summary_warning_codes
      FROM document_extraction_jobs AS jobs
      WHERE jobs.document_id = ?
      ORDER BY jobs.created_at DESC, jobs.rowid DESC
      LIMIT ?
    `).all(documentId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...mapExtractionJob(row),
      summaryBlockCount: Number(row.summary_block_count) || 0,
      summaryWarningCodes: parseStringArray(row.summary_warning_codes),
    }));
  }

  claimNextQueuedExtractionJob(): OcrExtractionJob | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM document_extraction_jobs
        WHERE status = 'queued'
        ORDER BY created_at, rowid
        LIMIT 1
      `).get() as { id: string } | undefined;
      if (!row) return null;
      const updated = this.db.prepare(`
        UPDATE document_extraction_jobs
        SET status = 'running', started_at = ?, completed_at = NULL,
            result_json = NULL, result_block_count = 0,
            result_warning_codes = '[]', error_code = NULL
        WHERE id = ? AND status = 'queued'
      `).run(new Date().toISOString(), row.id);
      return updated.changes === 1 ? row.id : null;
    });
    const id = claim();
    return id ? this.requireExtractionJob(id) : null;
  }

  recoverInterruptedExtractionJobs(): number {
    return this.db.prepare(`
      UPDATE document_extraction_jobs
      SET status = 'queued', started_at = NULL, completed_at = NULL,
          result_json = NULL, result_block_count = 0,
          result_warning_codes = '[]', error_code = NULL
      WHERE status = 'running'
    `).run().changes;
  }

  createDraftFromAuthoritativeJob(jobId: string, createdBy: string): DocumentReviewDraft {
    if (!createdBy.trim() || createdBy.length > 120) {
      throw new Error('Review author is invalid');
    }
    const create = this.db.transaction(() => {
      const job = this.requireExtractionJob(jobId);
      if (job.role !== 'authoritative') {
        throw new DocumentReviewConflictError('Only authoritative extraction can create a review draft');
      }
      if (job.status !== 'succeeded' || !job.result) {
        throw new DocumentReviewConflictError('Authoritative extraction is not complete');
      }
      const existing = this.db.prepare(`
        SELECT id FROM document_review_drafts WHERE source_job_id = ?
      `).get(jobId) as { id: string } | undefined;
      if (existing) return existing.id;

      const id = uuidv4();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO document_review_drafts (
          id, document_id, source_job_id, revision, status, created_by,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'open', ?, ?, ?, ?)
      `).run(id, job.documentId, job.id, createdBy.trim(), createdBy.trim(), now, now);
      insertDraftBlocks(this.db, id, job.result.blocks, new Set(), now);
      return id;
    });
    return this.requireDraft(create());
  }

  getDraft(id: string): DocumentReviewDraft | null {
    const row = this.db.prepare(`
      SELECT * FROM document_review_drafts WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDraft(row) : null;
  }

  findLatestDraft(documentId: string): DocumentReviewDraft | null {
    const row = this.db.prepare(`
      SELECT * FROM document_review_drafts
      WHERE document_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(documentId) as Record<string, unknown> | undefined;
    return row ? this.mapDraft(row) : null;
  }

  findLatestDraftSummary(documentId: string): DocumentReviewDraftSummaryRecord | null {
    const row = this.db.prepare(`
      SELECT d.id, d.revision, d.status, d.updated_by, d.updated_at, d.published_at,
             COUNT(b.block_id) AS block_count,
             COALESCE(SUM(b.manually_edited), 0) AS manually_edited_block_count
      FROM document_review_drafts d
      LEFT JOIN document_review_blocks b ON b.draft_id = d.id
      WHERE d.id = (
        SELECT latest.id
        FROM document_review_drafts latest
        WHERE latest.document_id = ?
        ORDER BY latest.created_at DESC, latest.rowid DESC
        LIMIT 1
      )
      GROUP BY d.id
    `).get(documentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      revision: row.revision as number,
      status: row.status as DocumentReviewDraftStatus,
      blockCount: row.block_count as number,
      manuallyEditedBlockCount: row.manually_edited_block_count as number,
      updatedBy: row.updated_by as string,
      updatedAt: row.updated_at as string,
      publishedAt: row.published_at as string | null,
    };
  }

  listLatestDraftBlocks(
    documentId: string,
    limit: number,
    offset: number,
  ): {
    draft: Omit<DocumentReviewDraft, 'blocks'>;
    items: DocumentReviewBlock[];
    total: number;
  } | null {
    const row = this.db.prepare(`
      SELECT * FROM document_review_drafts
      WHERE document_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(documentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const draft = mapDraftMetadata(row);
    const rows = this.db.prepare(`
      SELECT * FROM document_review_blocks
      WHERE draft_id = ? ORDER BY block_order LIMIT ? OFFSET ?
    `).all(draft.id, limit, offset) as Record<string, unknown>[];
    const count = this.db.prepare(`
      SELECT COUNT(*) AS total FROM document_review_blocks WHERE draft_id = ?
    `).get(draft.id) as { total: number };
    const items = rows.map((row) => {
      const parsed = parseDraftBlock(row);
      const block = parsed.block;
      if (
        block.id !== row.block_id
        || block.order !== row.block_order
        || (!parsed.recovered && block.kind !== row.kind)
      ) {
        throw new Error('Review draft block metadata is inconsistent');
      }
      return {
        ...block,
        manuallyEdited: Boolean(row.manually_edited),
      } as DocumentReviewBlock;
    });
    return { draft, items, total: count.total };
  }

  replaceDraftBlocks(
    id: string,
    expectedRevision: number,
    input: unknown,
    updatedBy: string,
  ): DocumentReviewDraft {
    const blocks = validateOcrDraftBlocks(input);
    if (!updatedBy.trim() || updatedBy.length > 120) {
      throw new Error('Review author is invalid');
    }
    const replace = this.db.transaction(() => {
      const draft = this.requireDraft(id);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) {
        throw new DocumentReviewConflictError('Review draft revision is stale');
      }
      if (draft.blocks.some((block) => (
        block.exclusionReason === 'malformed_historical_payload'
      ))) {
        throw new DocumentReviewConflictError(
          'Review draft contains malformed historical payload',
        );
      }
      if (
        blocks.length !== draft.blocks.length
        || blocks.some((block, index) => (
          block.id !== draft.blocks[index].id
          || block.order !== draft.blocks[index].order
          || block.kind !== draft.blocks[index].kind
        ))
      ) {
        throw new DocumentReviewConflictError('Review draft block identity cannot change');
      }
      const previous = new Map(draft.blocks.map((block) => [
        block.id,
        {
          payload: JSON.stringify(stripReviewMetadata(block)),
          manuallyEdited: block.manuallyEdited,
        },
      ]));
      const editedIds = new Set(blocks.flatMap((block) => {
        const prior = previous.get(block.id);
        return !prior || prior.manuallyEdited || prior.payload !== JSON.stringify(block)
          ? [block.id]
          : [];
      }));
      const now = new Date().toISOString();
      this.db.prepare('DELETE FROM document_review_blocks WHERE draft_id = ?').run(id);
      insertDraftBlocks(this.db, id, blocks, editedIds, now);
      const updated = this.db.prepare(`
        UPDATE document_review_drafts
        SET revision = revision + 1, updated_by = ?, updated_at = ?
        WHERE id = ? AND status = 'open' AND revision = ?
      `).run(updatedBy.trim(), now, id, expectedRevision);
      if (updated.changes !== 1) {
        throw new DocumentReviewConflictError('Review draft revision is stale');
      }
    });
    replace();
    return this.requireDraft(id);
  }

  publishDraft(
    id: string,
    expectedRevision: number,
    applyPublication: (blocks: DocumentBlock[]) => void,
  ): DocumentReviewDraft {
    const publish = this.db.transaction(() => {
      const draft = this.requireDraft(id);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) {
        throw new DocumentReviewConflictError('Review draft revision is stale');
      }
      if (draft.blocks.some((block) => (
        block.exclusionReason === 'malformed_historical_payload'
      ))) {
        throw new DocumentReviewConflictError(
          'Review draft contains malformed historical payload',
        );
      }
      const blocks = validateOcrDraftBlocks(
        draft.blocks.map((block) => stripReviewMetadata(block)),
      );
      applyPublication(blocks);
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE document_review_drafts
        SET status = 'superseded', updated_at = ?
        WHERE document_id = ? AND status = 'open' AND id <> ?
      `).run(now, draft.documentId, id);
      const updated = this.db.prepare(`
        UPDATE document_review_drafts
        SET status = 'published', updated_at = ?, published_at = ?
        WHERE id = ? AND status = 'open' AND revision = ?
      `).run(now, now, id, expectedRevision);
      if (updated.changes !== 1) {
        throw new DocumentReviewConflictError('Review draft revision is stale');
      }
    });
    publish();
    return this.requireDraft(id);
  }

  private requireExtractionJob(id: string): OcrExtractionJob {
    const job = this.getExtractionJob(id);
    if (!job) throw new Error('Extraction job not found');
    return job;
  }

  private requireDraft(id: string): DocumentReviewDraft {
    const draft = this.getDraft(id);
    if (!draft) throw new Error('Review draft not found');
    return draft;
  }

  private mapDraft(row: Record<string, unknown>): DocumentReviewDraft {
    const blockRows = this.db.prepare(`
      SELECT * FROM document_review_blocks
      WHERE draft_id = ? ORDER BY block_order
    `).all(row.id) as Record<string, unknown>[];
    const parsedBlocks = blockRows.map(parseDraftBlock);
    const blocks = validateOcrDraftBlocks(parsedBlocks.map(({ block }) => block));
    if (blocks.some((block, index) => (
      block.id !== blockRows[index].block_id
      || block.order !== blockRows[index].block_order
      || (!parsedBlocks[index].recovered && block.kind !== blockRows[index].kind)
    ))) {
      throw new Error('Review draft block metadata is inconsistent');
    }
    return {
      id: row.id as string,
      documentId: row.document_id as string,
      sourceJobId: row.source_job_id as string,
      revision: row.revision as number,
      status: row.status as DocumentReviewDraftStatus,
      blocks: blocks.map((block, index) => ({
        ...block,
        manuallyEdited: Boolean(blockRows[index].manually_edited),
      })) as DocumentReviewBlock[],
      createdBy: row.created_by as string,
      updatedBy: row.updated_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      publishedAt: row.published_at as string | null,
    };
  }
}

function assertEngineRole(role: OcrExtractionRole, engine: OcrEngineName): void {
  if (
    (role === 'authoritative' && engine !== 'paddleocr_ppstructurev3')
    || (role === 'shadow' && engine !== 'deepseek_ocr2')
  ) {
    throw new Error('OCR engine is not allowed for this extraction role');
  }
}

function mapDraftMetadata(
  row: Record<string, unknown>,
): Omit<DocumentReviewDraft, 'blocks'> {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    sourceJobId: row.source_job_id as string,
    revision: row.revision as number,
    status: row.status as DocumentReviewDraftStatus,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    publishedAt: row.published_at as string | null,
  };
}

function mapExtractionJob(row: Record<string, unknown>): OcrExtractionJob {
  let result: OcrExtractionResult | null = null;
  if (typeof row.result_json === 'string') {
    try {
      result = validateOcrExtractionResult(JSON.parse(row.result_json));
    } catch {
      result = null;
    }
  }
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    sourceVersion: row.source_version as number,
    role: row.role as OcrExtractionRole,
    engine: row.engine as OcrEngineName,
    engineVersion: row.engine_version as string,
    status: row.status as OcrExtractionJobStatus,
    retryOf: row.retry_of as string | null,
    result,
    errorCode: row.error_code as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function insertDraftBlocks(
  db: Database.Database,
  draftId: string,
  blocks: DocumentBlock[],
  editedIds: Set<string>,
  now: string,
): void {
  const insert = db.prepare(`
    INSERT INTO document_review_blocks (
      draft_id, block_id, block_order, kind, payload, manually_edited, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const block of blocks) {
    insert.run(
      draftId,
      block.id,
      block.order,
      block.kind,
      JSON.stringify(block),
      Number(editedIds.has(block.id)),
      now,
    );
  }
}

function parseDraftBlock(
  row: Record<string, unknown>,
): { block: DocumentBlock; recovered: boolean } {
  try {
    return {
      block: documentBlockSchema.parse(JSON.parse(row.payload as string)),
      recovered: false,
    };
  } catch {
    const common = {
      id: typeof row.block_id === 'string' && /^block-\d{6}$/.test(row.block_id)
        ? row.block_id
        : 'block-000001',
      order: Number.isInteger(row.block_order) && Number(row.block_order) >= 0
        ? Number(row.block_order)
        : 0,
      pageNumber: null,
      headingPath: [],
      confidence: 0,
      layout: null,
      excluded: true,
      exclusionReason: 'malformed_historical_payload',
    };
    const block = row.kind === 'heading'
      ? { ...common, kind: 'heading' as const, level: 1, text: '' }
      : row.kind === 'list'
        ? { ...common, kind: 'list' as const, ordered: false, items: [] }
        : row.kind === 'table'
          ? {
            ...common,
            kind: 'table' as const,
            rowCount: 0,
            columnCount: 0,
            cells: [],
          }
          : row.kind === 'key_value'
            ? { ...common, kind: 'key_value' as const, pairs: [] }
            : row.kind === 'image_ref'
              ? {
                ...common,
                kind: 'image_ref' as const,
                relationshipId: null,
                contentType: null,
                altText: null,
                requiresVisualProcessing: true as const,
              }
              : row.kind === 'text'
                ? { ...common, kind: 'text' as const, text: '', variant: 'plain' as const }
                : { ...common, kind: 'paragraph' as const, text: '' };
    return { block: documentBlockSchema.parse(block), recovered: true };
  }
}

function stripReviewMetadata(block: DocumentReviewBlock): DocumentBlock {
  const { manuallyEdited: _manuallyEdited, ...payload } = block;
  return payload;
}

export class DocumentReviewConflictError extends Error {}
