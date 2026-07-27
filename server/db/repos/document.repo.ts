import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  DocumentChunk,
  DocumentIndexStatus,
  DocumentFormat,
  DocumentProcessingStageName,
  DocumentProcessingSummary,
  DocumentQualityDecision,
  DocumentRecord,
  DocumentRepresentationSummary,
  DocumentStatus,
} from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';
import {
  DocumentBlock,
  StructuredDocument,
  documentBlockSchema,
  validateDocumentIR,
} from '../../ai/document-ir';

export interface DocumentKnowledgeChunk extends DocumentChunk {
  documentTitle: string;
}

export class DocumentRepo {
  constructor(private readonly db: Database.Database) {}

  createPending(params: {
    id: string;
    fileName: string;
    storagePath: string;
    format: DocumentFormat;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    uploadedBy: string;
  }): DocumentRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO documents (
        id, file_name, storage_path, format, source_format, mime_type, size_bytes, sha256,
        status, is_active, parser_version, chunker_version, failure_code,
        character_count, chunk_count, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, 'parser-v1', 'semantic-v1', NULL, 0, 0, ?, ?, ?)
    `).run(
      params.id,
      params.fileName,
      params.storagePath,
      legacyStoredFormat(params.format),
      params.format,
      params.mimeType,
      params.sizeBytes,
      params.sha256,
      params.uploadedBy,
      now,
      now,
    );
    return this.findById(params.id) as DocumentRecord;
  }

  findById(id: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  findBySha256(sha256: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha256) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  replaceChunksAndMarkReady(
    documentId: string,
    chunks: Array<
      Omit<DocumentChunk, 'id' | 'documentId' | 'createdAt' | 'embeddingProfile'>
      & { id?: string; embeddingProfile?: string | null }
    >,
    characterCount: number,
    metadata?: {
      taskId: string;
      representationId: string;
      representationVersion: string;
      parserVersion: string;
      cleanerVersion: string;
      chunkerVersion: string;
      qualityDecision: DocumentQualityDecision;
      qualityReasons: string[];
      indexStatus: DocumentIndexStatus;
    },
  ): DocumentRecord {
    this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId);
    const insert = this.db.prepare(`
        INSERT INTO document_chunks (
          id, document_id, chunk_index, content, title, page_start, page_end,
          character_count, embedding, embedding_profile, source_block_ids,
          heading_path, representation_version, chunker_version,
          extraction_job_id, extraction_engine, extraction_engine_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      insert.run(
        chunk.id ?? uuidv4(),
        documentId,
        chunk.chunkIndex,
        chunk.content,
        chunk.title,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.characterCount,
        JSON.stringify(chunk.embedding),
        chunk.embeddingProfile ?? null,
        JSON.stringify(chunk.sourceBlockIds ?? []),
        JSON.stringify(chunk.headingPath ?? []),
        chunk.representationVersion ?? null,
        chunk.chunkerVersion ?? null,
        chunk.extractionJobId ?? null,
        chunk.extractionEngine ?? null,
        chunk.extractionEngineVersion ?? null,
        now,
      );
    }
    if (metadata) {
      this.db.prepare(`
        UPDATE documents
        SET status = 'ready', failure_code = NULL, character_count = ?,
            chunk_count = ?, parser_version = ?, chunker_version = ?,
            representation_version = ?, cleaner_version = ?,
            quality_decision = ?, quality_reasons = ?, latest_task_id = ?,
            latest_representation_id = ?, index_status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        characterCount,
        chunks.length,
        metadata.parserVersion,
        metadata.chunkerVersion,
        metadata.representationVersion,
        metadata.cleanerVersion,
        metadata.qualityDecision,
        JSON.stringify(metadata.qualityReasons),
        metadata.taskId,
        metadata.representationId,
        metadata.indexStatus,
        now,
        documentId,
      );
    } else {
      this.db.prepare(`
        UPDATE documents
        SET status = 'ready', failure_code = NULL, character_count = ?, chunk_count = ?, updated_at = ?
        WHERE id = ?
      `).run(characterCount, chunks.length, now, documentId);
    }
    return this.findById(documentId) as DocumentRecord;
  }

  markFailed(documentId: string, failureCode: string, metadata?: {
    taskId?: string;
    representationId?: string | null;
    representationVersion?: string | null;
    parserVersion?: string | null;
    cleanerVersion?: string | null;
    chunkerVersion?: string | null;
    qualityDecision?: DocumentQualityDecision | null;
    qualityReasons?: string[];
    indexStatus?: DocumentIndexStatus;
  }): DocumentRecord {
    this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId);
    const now = new Date().toISOString();
    if (metadata) {
      this.db.prepare(`
        UPDATE documents
        SET status = 'failed', failure_code = ?, character_count = 0,
            chunk_count = 0, latest_task_id = COALESCE(?, latest_task_id),
            latest_representation_id = COALESCE(?, latest_representation_id),
            representation_version = COALESCE(?, representation_version),
            parser_version = COALESCE(?, parser_version),
            cleaner_version = COALESCE(?, cleaner_version),
            chunker_version = COALESCE(?, chunker_version),
            quality_decision = ?, quality_reasons = ?,
            index_status = COALESCE(?, index_status), updated_at = ?
        WHERE id = ?
      `).run(
        failureCode,
        metadata.taskId ?? null,
        metadata.representationId ?? null,
        metadata.representationVersion ?? null,
        metadata.parserVersion ?? null,
        metadata.cleanerVersion ?? null,
        metadata.chunkerVersion ?? null,
        metadata.qualityDecision ?? null,
        JSON.stringify(metadata.qualityReasons ?? []),
        metadata.indexStatus ?? null,
        now,
        documentId,
      );
    } else {
      this.db.prepare(`
          UPDATE documents
          SET status = 'failed', failure_code = ?, character_count = 0, chunk_count = 0, updated_at = ?
          WHERE id = ?
        `).run(failureCode, now, documentId);
    }
    return this.findById(documentId) as DocumentRecord;
  }

  markPending(documentId: string): DocumentRecord {
    this.db.prepare(`
      UPDATE documents SET status = 'pending', failure_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(new Date().toISOString(), documentId);
    return this.findById(documentId) as DocumentRecord;
  }

  setActive(documentId: string, isActive: number): DocumentRecord {
    this.db.prepare(`
      UPDATE documents SET is_active = ?, updated_at = ?
      WHERE id = ? AND status = 'ready'
    `).run(isActive, new Date().toISOString(), documentId);
    return this.findById(documentId) as DocumentRecord;
  }

  search(params: {
    status: DocumentStatus | null;
    isActive: number | null;
    keyword: string;
    limit: number;
    offset: number;
  }): { items: DocumentRecord[]; total: number } {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (params.status) {
      clauses.push('status = ?');
      values.push(params.status);
    }
    if (params.isActive !== null) {
      clauses.push('is_active = ?');
      values.push(params.isActive);
    }
    if (params.keyword) {
      clauses.push("file_name LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLikePattern(params.keyword)}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM documents ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(...values, params.limit, params.offset) as Record<string, unknown>[];
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM documents ${where}`)
      .get(...values) as { total: number };
    return { items: rows.map((row) => this.mapDocument(row)), total: count.total };
  }

  listAllActiveChunks(): DocumentChunk[] {
    const rows = this.db.prepare(`
      SELECT c.* FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND d.is_active = 1
        AND d.index_status IN ('legacy', 'published')
      ORDER BY d.updated_at DESC, c.chunk_index
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapChunk(row));
  }

  listAllActiveKnowledgeChunks(): DocumentKnowledgeChunk[] {
    const rows = this.db.prepare(`
      SELECT c.*, d.file_name AS document_title FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND d.is_active = 1
        AND d.index_status IN ('legacy', 'published')
      ORDER BY d.updated_at DESC, c.chunk_index
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      ...this.mapChunk(row),
      documentTitle: row.document_title as string,
    }));
  }

  searchActiveChunksLikeTerms(terms: string[], limit: number): DocumentKnowledgeChunk[] {
    const uniqueTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, 24);
    if (uniqueTerms.length === 0) return [];
    const termClause = uniqueTerms.map(() => (
      "(c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR d.file_name LIKE ? ESCAPE '\\')"
    )).join(' OR ');
    const patterns = uniqueTerms.flatMap((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return [pattern, pattern, pattern];
    });
    const rows = this.db.prepare(`
      SELECT c.*, d.file_name AS document_title FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND d.is_active = 1
        AND d.index_status IN ('legacy', 'published')
        AND (${termClause})
      ORDER BY d.updated_at DESC, c.chunk_index
      LIMIT ?
    `).all(...patterns, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...this.mapChunk(row),
      documentTitle: row.document_title as string,
    }));
  }

  updateKnowledgeChunkEmbeddings(
    updates: Array<{
      id: string;
      embedding: number[];
      embeddingProfile: string | null;
    }>,
  ): void {
    const statement = this.db.prepare(`
      UPDATE document_chunks
      SET embedding = ?, embedding_profile = ?
      WHERE id = ?
    `);
    this.db.transaction(() => {
      for (const update of updates) {
        const result = statement.run(
          JSON.stringify(update.embedding),
          update.embeddingProfile,
          update.id,
        );
        if (result.changes !== 1) throw new Error('Document chunk embedding target disappeared');
      }
    })();
  }

  delete(documentId: string): boolean {
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId).changes > 0;
  }

  restore(document: DocumentRecord, chunks: DocumentChunk[]): void {
    this.db.prepare(`
      INSERT INTO documents (
        id, file_name, storage_path, format, source_format, mime_type, size_bytes, sha256,
        status, is_active, parser_version, chunker_version, failure_code,
        character_count, chunk_count, source_version, representation_version,
        cleaner_version, quality_decision, quality_reasons, latest_task_id,
        latest_representation_id, index_status, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.id,
      document.fileName,
      document.storagePath,
      legacyStoredFormat(document.format),
      document.format,
      document.mimeType,
      document.sizeBytes,
      document.sha256,
      document.status,
      document.isActive,
      document.parserVersion,
      document.chunkerVersion,
      document.failureCode,
      document.characterCount,
      document.chunkCount,
      document.sourceVersion,
      document.representationVersion,
      document.cleanerVersion,
      document.qualityDecision,
      JSON.stringify(document.qualityReasons),
      document.latestTaskId,
      document.latestRepresentationId,
      document.indexStatus,
      document.uploadedBy,
      document.createdAt,
      document.updatedAt,
    );
    const insertChunk = this.db.prepare(`
      INSERT INTO document_chunks (
        id, document_id, chunk_index, content, title, page_start, page_end,
        character_count, embedding, embedding_profile, source_block_ids,
        heading_path, representation_version, chunker_version,
        extraction_job_id, extraction_engine, extraction_engine_version,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      insertChunk.run(
        chunk.id,
        chunk.documentId,
        chunk.chunkIndex,
        chunk.content,
        chunk.title,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.characterCount,
        JSON.stringify(chunk.embedding),
        chunk.embeddingProfile,
        JSON.stringify(chunk.sourceBlockIds ?? []),
        JSON.stringify(chunk.headingPath ?? []),
        chunk.representationVersion ?? null,
        chunk.chunkerVersion ?? null,
        chunk.extractionJobId ?? null,
        chunk.extractionEngine ?? null,
        chunk.extractionEngineVersion ?? null,
        chunk.createdAt,
      );
    }
  }

  listChunks(documentId: string, limit: number, offset: number): { items: DocumentChunk[]; total: number } {
    const rows = this.db.prepare(`
      SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT ? OFFSET ?
    `).all(documentId, limit, offset) as Record<string, unknown>[];
    const count = this.db.prepare('SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?')
      .get(documentId) as { total: number };
    return { items: rows.map((row) => this.mapChunk(row)), total: count.total };
  }

  createProcessingTask(params: {
    documentId: string;
    sourceVersion: number;
    retryOf?: string | null;
    inputBytes: number;
  }): string {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO document_processing_tasks (
        id, document_id, source_version, retry_of, status, index_status,
        input_bytes, started_at
      ) VALUES (?, ?, ?, ?, 'running', 'not_indexed', ?, ?)
    `).run(
      id,
      params.documentId,
      params.sourceVersion,
      params.retryOf ?? null,
      params.inputBytes,
      now,
    );
    this.db.prepare(`
      UPDATE documents SET latest_task_id = ?, updated_at = ? WHERE id = ?
    `).run(id, now, params.documentId);
    return id;
  }

  startProcessingStage(
    taskId: string,
    name: DocumentProcessingStageName,
    order: number,
    inputCount: number | null = null,
  ): void {
    this.db.prepare(`
      INSERT INTO document_processing_stages (
        task_id, stage_name, stage_order, status, started_at, input_count
      ) VALUES (?, ?, ?, 'running', ?, ?)
      ON CONFLICT(task_id, stage_name) DO UPDATE SET
        stage_order = excluded.stage_order,
        status = 'running',
        started_at = excluded.started_at,
        completed_at = NULL,
        input_count = excluded.input_count,
        output_count = NULL,
        error_code = NULL
    `).run(taskId, name, order, new Date().toISOString(), inputCount);
  }

  completeProcessingStage(
    taskId: string,
    name: DocumentProcessingStageName,
    outputCount: number | null = null,
  ): void {
    this.db.prepare(`
      UPDATE document_processing_stages
      SET status = 'succeeded', completed_at = ?, output_count = ?, error_code = NULL
      WHERE task_id = ? AND stage_name = ?
    `).run(new Date().toISOString(), outputCount, taskId, name);
  }

  failProcessingStage(taskId: string, name: DocumentProcessingStageName, errorCode: string): void {
    this.db.prepare(`
      UPDATE document_processing_stages
      SET status = 'failed', completed_at = ?, error_code = ?
      WHERE task_id = ? AND stage_name = ?
    `).run(new Date().toISOString(), errorCode, taskId, name);
  }

  completeProcessingTask(params: {
    taskId: string;
    representationVersion: string | null;
    parserVersion: string | null;
    cleanerVersion: string | null;
    chunkerVersion: string | null;
    qualityDecision: DocumentQualityDecision | null;
    qualityReasons: string[];
    failureCode: string | null;
    indexStatus: DocumentIndexStatus;
    outputCharacters: number;
    blockCount: number;
    chunkCount: number;
    succeeded: boolean;
  }): void {
    this.db.prepare(`
      UPDATE document_processing_tasks
      SET status = ?, representation_version = ?, parser_version = ?,
          cleaner_version = ?, chunker_version = ?, quality_decision = ?,
          quality_reasons = ?, failure_code = ?, index_status = ?, output_characters = ?,
          block_count = ?, chunk_count = ?, completed_at = ?
      WHERE id = ?
    `).run(
      params.succeeded ? 'succeeded' : 'failed',
      params.representationVersion,
      params.parserVersion,
      params.cleanerVersion,
      params.chunkerVersion,
      params.qualityDecision,
      JSON.stringify(params.qualityReasons),
      params.failureCode,
      params.indexStatus,
      params.outputCharacters,
      params.blockCount,
      params.chunkCount,
      new Date().toISOString(),
      params.taskId,
    );
  }

  saveRepresentation(
    documentId: string,
    taskId: string,
    cleanerVersion: string,
    representation: StructuredDocument,
  ): string {
    const id = uuidv4();
    const now = new Date().toISOString();
    const insertRepresentation = this.db.prepare(`
      INSERT INTO document_representations (
        id, document_id, task_id, schema_version, parser_name, parser_version,
        cleaner_version, source, warnings, metrics, block_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBlock = this.db.prepare(`
      INSERT INTO document_representation_blocks (
        representation_id, block_id, block_order, kind, page_number,
        heading_path, excluded, exclusion_reason, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      insertRepresentation.run(
        id,
        documentId,
        taskId,
        representation.schemaVersion,
        representation.parser.name,
        representation.parser.version,
        cleanerVersion,
        JSON.stringify(representation.source),
        JSON.stringify(representation.warnings),
        JSON.stringify(representation.metrics),
        representation.blocks.length,
        now,
      );
      for (const block of representation.blocks) {
        insertBlock.run(
          id,
          block.id,
          block.order,
          block.kind,
          block.pageNumber,
          JSON.stringify(block.headingPath),
          Number(block.excluded),
          block.exclusionReason,
          JSON.stringify(block),
        );
      }
    })();
    return id;
  }

  getRepresentation(id: string): StructuredDocument | null {
    const row = this.db.prepare(`
      SELECT * FROM document_representations WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const blockRows = this.db.prepare(`
      SELECT * FROM document_representation_blocks
      WHERE representation_id = ? ORDER BY block_order
    `).all(id) as Record<string, unknown>[];
    try {
      return validateDocumentIR({
        schemaVersion: row.schema_version,
        source: parseJson(row.source, {}),
        parser: {
          name: row.parser_name,
          version: row.parser_version,
        },
        blocks: blockRows.map(mapRepresentationBlock),
        warnings: parseJson(row.warnings, []),
        metrics: parseJson(row.metrics, {}),
      });
    } catch {
      return null;
    }
  }

  listRepresentationBlocks(
    representationId: string,
    limit: number,
    offset: number,
  ): { items: DocumentBlock[]; total: number } {
    const rows = this.db.prepare(`
      SELECT * FROM document_representation_blocks
      WHERE representation_id = ? ORDER BY block_order LIMIT ? OFFSET ?
    `).all(representationId, limit, offset) as Record<string, unknown>[];
    const count = this.db.prepare(`
      SELECT COUNT(*) AS total FROM document_representation_blocks
      WHERE representation_id = ?
    `).get(representationId) as { total: number };
    return { items: rows.map(mapRepresentationBlock), total: count.total };
  }

  getRepresentationSummary(id: string | null): DocumentRepresentationSummary | null {
    if (!id) return null;
    const row = this.db.prepare(`
      SELECT * FROM document_representations WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const warnings = parseJson<Array<{ code?: unknown }>>(row.warnings, []);
    const metrics = parseJson<Record<string, number>>(row.metrics, {});
    return {
      id: row.id as string,
      schemaVersion: row.schema_version as string,
      parserName: row.parser_name as string,
      parserVersion: row.parser_version as string,
      cleanerVersion: row.cleaner_version as string,
      blockCount: row.block_count as number,
      warningCodes: warnings.flatMap((warning) => (
        typeof warning.code === 'string' ? [warning.code] : []
      )),
      metrics,
      createdAt: row.created_at as string,
    };
  }

  getProcessingSummary(taskId: string | null): DocumentProcessingSummary | null {
    if (!taskId) return null;
    const row = this.db.prepare(`
      SELECT * FROM document_processing_tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const stages = this.db.prepare(`
      SELECT * FROM document_processing_stages
      WHERE task_id = ? ORDER BY stage_order
    `).all(taskId) as Record<string, unknown>[];
    return {
      taskId: row.id as string,
      status: row.status as DocumentProcessingSummary['status'],
      retryOf: row.retry_of as string | null,
      representationVersion: row.representation_version as string | null,
      parserVersion: row.parser_version as string | null,
      cleanerVersion: row.cleaner_version as string | null,
      chunkerVersion: row.chunker_version as string | null,
      qualityDecision: row.quality_decision as DocumentQualityDecision | null,
      qualityReasons: parseJson<string[]>(row.quality_reasons, []),
      failureCode: row.failure_code as string | null,
      indexStatus: row.index_status as DocumentIndexStatus,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | null,
      inputBytes: row.input_bytes as number,
      outputCharacters: row.output_characters as number,
      blockCount: row.block_count as number,
      chunkCount: row.chunk_count as number,
      stages: stages.map((stage) => ({
        name: stage.stage_name as DocumentProcessingStageName,
        order: stage.stage_order as number,
        status: stage.status as DocumentProcessingSummary['stages'][number]['status'],
        startedAt: stage.started_at as string,
        completedAt: stage.completed_at as string | null,
        inputCount: stage.input_count as number | null,
        outputCount: stage.output_count as number | null,
        errorCode: stage.error_code as string | null,
      })),
    };
  }

  setIndexStatus(documentId: string, indexStatus: DocumentIndexStatus, isActive?: number): void {
    if (isActive === undefined) {
      this.db.prepare(`
        UPDATE documents SET index_status = ?, updated_at = ? WHERE id = ?
      `).run(indexStatus, new Date().toISOString(), documentId);
    } else {
      this.db.prepare(`
        UPDATE documents SET index_status = ?, is_active = ?, updated_at = ? WHERE id = ?
      `).run(indexStatus, isActive, new Date().toISOString(), documentId);
    }
  }

  restorePublishedState(
    document: DocumentRecord,
    chunks: DocumentChunk[],
    latestTaskId: string,
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO document_chunks (
        id, document_id, chunk_index, content, title, page_start, page_end,
        character_count, embedding, embedding_profile, source_block_ids,
        heading_path, representation_version, chunker_version,
        extraction_job_id, extraction_engine, extraction_engine_version,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(document.id);
      for (const chunk of chunks) {
        insert.run(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.title,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.characterCount,
          JSON.stringify(chunk.embedding),
          chunk.embeddingProfile,
          JSON.stringify(chunk.sourceBlockIds ?? []),
          JSON.stringify(chunk.headingPath ?? []),
          chunk.representationVersion ?? null,
          chunk.chunkerVersion ?? null,
          chunk.extractionJobId ?? null,
          chunk.extractionEngine ?? null,
          chunk.extractionEngineVersion ?? null,
          chunk.createdAt,
        );
      }
      this.db.prepare(`
        UPDATE documents
        SET status = ?, is_active = ?, parser_version = ?, chunker_version = ?,
            failure_code = ?, character_count = ?, chunk_count = ?,
            source_version = ?, representation_version = ?, cleaner_version = ?,
            quality_decision = ?, quality_reasons = ?, latest_task_id = ?,
            latest_representation_id = ?, index_status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        document.status,
        document.isActive,
        document.parserVersion,
        document.chunkerVersion,
        document.failureCode,
        document.characterCount,
        document.chunkCount,
        document.sourceVersion,
        document.representationVersion,
        document.cleanerVersion,
        document.qualityDecision,
        JSON.stringify(document.qualityReasons),
        latestTaskId,
        document.latestRepresentationId,
        document.indexStatus,
        new Date().toISOString(),
        document.id,
      );
    })();
  }

  private mapDocument(row: Record<string, unknown>): DocumentRecord {
    return {
      id: row.id as string,
      fileName: row.file_name as string,
      storagePath: row.storage_path as string,
      format: mapDocumentFormat(row.source_format, row.format),
      mimeType: row.mime_type as string,
      sizeBytes: row.size_bytes as number,
      sha256: row.sha256 as string,
      status: row.status as DocumentStatus,
      isActive: row.is_active as number,
      parserVersion: row.parser_version as string,
      chunkerVersion: row.chunker_version as string,
      failureCode: row.failure_code as string | null,
      characterCount: row.character_count as number,
      chunkCount: row.chunk_count as number,
      sourceVersion: (row.source_version as number | undefined) ?? 1,
      representationVersion: row.representation_version as string | null,
      cleanerVersion: row.cleaner_version as string | null,
      qualityDecision: row.quality_decision as DocumentQualityDecision | null,
      qualityReasons: parseJson<string[]>(row.quality_reasons, []),
      latestTaskId: row.latest_task_id as string | null,
      latestRepresentationId: row.latest_representation_id as string | null,
      indexStatus: (row.index_status as DocumentIndexStatus | undefined) ?? 'legacy',
      uploadedBy: row.uploaded_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapChunk(row: Record<string, unknown>): DocumentChunk {
    let embedding: number[] = [];
    try {
      embedding = JSON.parse(row.embedding as string) as number[];
    } catch {
      embedding = [];
    }
    return {
      id: row.id as string,
      documentId: row.document_id as string,
      chunkIndex: row.chunk_index as number,
      content: row.content as string,
      title: row.title as string | null,
      pageStart: row.page_start as number | null,
      pageEnd: row.page_end as number | null,
      characterCount: row.character_count as number,
      embedding,
      embeddingProfile: row.embedding_profile as string | null,
      sourceBlockIds: parseJson<string[]>(row.source_block_ids, []),
      headingPath: parseJson<string[]>(row.heading_path, []),
      representationVersion: row.representation_version as string | null,
      chunkerVersion: row.chunker_version as string | null,
      extractionJobId: row.extraction_job_id as string | null,
      extractionEngine: row.extraction_engine as DocumentChunk['extractionEngine'],
      extractionEngineVersion: row.extraction_engine_version as string | null,
      createdAt: row.created_at as string,
    };
  }
}

function legacyStoredFormat(format: DocumentFormat): 'txt' | 'md' | 'pdf' | 'docx' {
  return ['png', 'jpeg', 'webp'].includes(format) ? 'txt' : format as 'txt' | 'md' | 'pdf' | 'docx';
}

function mapDocumentFormat(sourceFormat: unknown, storedFormat: unknown): DocumentFormat {
  const supportedFormats: DocumentFormat[] = [
    'txt',
    'md',
    'pdf',
    'docx',
    'png',
    'jpeg',
    'webp',
  ];
  if (
    typeof sourceFormat === 'string'
    && supportedFormats.includes(sourceFormat as DocumentFormat)
  ) {
    return sourceFormat as DocumentFormat;
  }
  return supportedFormats.includes(storedFormat as DocumentFormat)
    ? storedFormat as DocumentFormat
    : 'txt';
}

function mapRepresentationBlock(row: Record<string, unknown>): DocumentBlock {
  const parsed = documentBlockSchema.safeParse(parseJson(row.payload, null));
  if (parsed.success) return parsed.data;
  return {
    id: row.block_id as string,
    kind: 'text',
    order: row.block_order as number,
    pageNumber: row.page_number as number | null,
    headingPath: parseJson<string[]>(row.heading_path, []),
    confidence: null,
    layout: null,
    excluded: true,
    exclusionReason: 'malformed_historical_block',
    text: '',
    variant: 'plain',
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
