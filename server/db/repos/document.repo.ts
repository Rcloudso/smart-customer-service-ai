import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  DocumentChunk,
  DocumentFormat,
  DocumentRecord,
  DocumentStatus,
} from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';

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
        id, file_name, storage_path, format, mime_type, size_bytes, sha256,
        status, is_active, parser_version, chunker_version, failure_code,
        character_count, chunk_count, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 'parser-v1', 'semantic-v1', NULL, 0, 0, ?, ?, ?)
    `).run(
      params.id,
      params.fileName,
      params.storagePath,
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
      & { embeddingProfile?: string | null }
    >,
    characterCount: number,
  ): DocumentRecord {
    this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId);
    const insert = this.db.prepare(`
        INSERT INTO document_chunks (
          id, document_id, chunk_index, content, title, page_start, page_end,
          character_count, embedding, embedding_profile, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      insert.run(
        uuidv4(),
        documentId,
        chunk.chunkIndex,
        chunk.content,
        chunk.title,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.characterCount,
        JSON.stringify(chunk.embedding),
        chunk.embeddingProfile ?? null,
        now,
      );
    }
    this.db.prepare(`
        UPDATE documents
        SET status = 'ready', failure_code = NULL, character_count = ?, chunk_count = ?, updated_at = ?
        WHERE id = ?
      `).run(characterCount, chunks.length, now, documentId);
    return this.findById(documentId) as DocumentRecord;
  }

  markFailed(documentId: string, failureCode: string): DocumentRecord {
    this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId);
    this.db.prepare(`
        UPDATE documents
        SET status = 'failed', failure_code = ?, character_count = 0, chunk_count = 0, updated_at = ?
        WHERE id = ?
      `).run(failureCode, new Date().toISOString(), documentId);
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
      ORDER BY d.updated_at DESC, c.chunk_index
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapChunk(row));
  }

  listAllActiveKnowledgeChunks(): DocumentKnowledgeChunk[] {
    const rows = this.db.prepare(`
      SELECT c.*, d.file_name AS document_title FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND d.is_active = 1
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
        id, file_name, storage_path, format, mime_type, size_bytes, sha256,
        status, is_active, parser_version, chunker_version, failure_code,
        character_count, chunk_count, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.id,
      document.fileName,
      document.storagePath,
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
      document.uploadedBy,
      document.createdAt,
      document.updatedAt,
    );
    const insertChunk = this.db.prepare(`
      INSERT INTO document_chunks (
        id, document_id, chunk_index, content, title, page_start, page_end,
        character_count, embedding, embedding_profile, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  private mapDocument(row: Record<string, unknown>): DocumentRecord {
    return {
      id: row.id as string,
      fileName: row.file_name as string,
      storagePath: row.storage_path as string,
      format: row.format as DocumentFormat,
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
      createdAt: row.created_at as string,
    };
  }
}
