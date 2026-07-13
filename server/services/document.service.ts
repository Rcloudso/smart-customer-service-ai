import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ChunkingError, semanticChunk } from '../ai/document-chunker';
import { DocumentParserError, parseDocument } from '../ai/document-parser';
import { DocumentRepo } from '../db/repos/document.repo';
import {
  Document,
  DocumentChunk,
  DocumentChunkView,
  DocumentFormat,
  DocumentRecord,
  DocumentStatus,
} from '../types/domain';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../utils/errors';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 200_000;

type ReadyChunk = Omit<DocumentChunk, 'id' | 'documentId' | 'createdAt'>;

export interface DocumentServiceDependencies {
  uploadDir: string;
  embedTexts: (texts: string[]) => Promise<number[][]>;
  publishChunks?: (chunks: DocumentChunk[]) => void | Promise<void>;
  removeDocumentFromIndex?: (documentId: string, chunks: DocumentChunk[]) => void | Promise<void>;
}

export class DocumentService {
  private readonly repo: DocumentRepo;

  constructor(
    private readonly db: Database.Database,
    private readonly dependencies: DocumentServiceDependencies,
  ) {
    this.repo = new DocumentRepo(db);
  }

  async upload(params: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    uploadedBy: string;
  }): Promise<Document> {
    const format = this.validateUpload(params.originalName, params.mimeType, params.buffer);
    const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
    if (this.repo.findBySha256(sha256)) {
      throw new ConflictError('An identical document already exists');
    }

    const id = uuidv4();
    const storagePath = `${id}.${format}`;
    const finalPath = this.resolveStoragePath(storagePath);
    const temporaryPath = `${finalPath}.tmp`;
    try {
      fs.mkdirSync(this.dependencies.uploadDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dependencies.uploadDir, 0o700);
      fs.writeFileSync(temporaryPath, params.buffer, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, finalPath);
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      throw new ServiceUnavailableError('Document storage is unavailable');
    }

    let record: DocumentRecord;
    try {
      record = this.repo.createPending({
        id,
        fileName: path.basename(params.originalName),
        storagePath,
        format,
        mimeType: params.mimeType,
        sizeBytes: params.buffer.byteLength,
        sha256,
        uploadedBy: params.uploadedBy,
      });
    } catch (error) {
      fs.rmSync(finalPath, { force: true });
      throw error;
    }

    return this.toPublicDocument(await this.process(record, params.buffer));
  }

  get(documentId: string): Document {
    return this.toPublicDocument(this.requireDocument(documentId));
  }

  list(params: {
    status?: DocumentStatus | null;
    isActive?: boolean | null;
    keyword?: string;
    page: number;
    pageSize: number;
  }): { items: Document[]; total: number } {
    const result = this.repo.search({
      status: params.status ?? null,
      isActive: params.isActive == null ? null : Number(params.isActive),
      keyword: params.keyword?.trim() ?? '',
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });
    return { items: result.items.map((item) => this.toPublicDocument(item)), total: result.total };
  }

  listChunks(documentId: string, params: { page: number; pageSize: number }): {
    items: DocumentChunkView[];
    total: number;
  } {
    this.requireDocument(documentId);
    const result = this.repo.listChunks(documentId, params.pageSize, (params.page - 1) * params.pageSize);
    return {
      items: result.items.map(({ embedding: _embedding, ...chunk }) => chunk),
      total: result.total,
    };
  }

  async retry(documentId: string): Promise<Document> {
    let record = this.requireDocument(documentId);
    if (record.status !== 'failed') throw new ConflictError('Only failed documents can be retried');
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.resolveStoragePath(record.storagePath));
    } catch {
      return this.toPublicDocument(this.db.transaction(() => (
        this.repo.markFailed(documentId, 'source_file_missing')
      ))());
    }
    record = this.repo.markPending(documentId);
    return this.toPublicDocument(await this.process(record, buffer));
  }

  async setActive(documentId: string, isActive: boolean): Promise<Document> {
    const record = this.requireDocument(documentId);
    if (record.status !== 'ready') throw new ConflictError('Only ready documents can be activated or deactivated');
    const updated = this.repo.setActive(documentId, Number(isActive));
    const chunks = this.repo.listChunks(documentId, 300, 0).items;
    try {
      if (isActive) {
        await this.dependencies.publishChunks?.(chunks);
      } else {
        await this.dependencies.removeDocumentFromIndex?.(documentId, chunks);
      }
    } catch (error) {
      this.repo.setActive(documentId, record.isActive);
      try {
        if (record.isActive) {
          await this.dependencies.publishChunks?.(chunks);
        } else {
          await this.dependencies.removeDocumentFromIndex?.(documentId, chunks);
        }
      } catch {
        // Preserve the original indexing error after best-effort rollback.
      }
      throw error;
    }
    return this.toPublicDocument(updated);
  }

  async delete(documentId: string): Promise<void> {
    const record = this.requireDocument(documentId);
    const chunks = this.repo.listChunks(documentId, 300, 0).items;
    const filePath = this.resolveStoragePath(record.storagePath);
    const temporaryPath = `${filePath}.deleting`;
    let renamed = false;
    let databaseDeleted = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, temporaryPath);
        renamed = true;
      }
      await this.dependencies.removeDocumentFromIndex?.(documentId, chunks);
      if (!this.repo.delete(documentId)) throw new Error('Document delete did not change a row');
      databaseDeleted = true;
      if (renamed) fs.rmSync(temporaryPath);
    } catch (error) {
      if (databaseDeleted) {
        try {
          this.db.transaction(() => this.repo.restore(record, chunks))();
        } catch {
          // Continue the remaining compensation steps before returning a stable failure.
        }
      }
      try {
        if (record.isActive) await this.dependencies.publishChunks?.(chunks);
      } catch {
        // Preserve the original failure after best-effort index restoration.
      }
      try {
        if (renamed && fs.existsSync(temporaryPath)) fs.renameSync(temporaryPath, filePath);
      } catch {
        // Avoid exposing local paths while preserving the original delete failure.
      }
      throw error instanceof ConflictError || error instanceof NotFoundError
        ? error
        : new ServiceUnavailableError('Document deletion could not be completed');
    }
  }

  private async process(record: DocumentRecord, buffer: Buffer): Promise<DocumentRecord> {
    try {
      const parsed = await parseDocument(buffer, record.format);
      if (parsed.characterCount > MAX_EXTRACTED_CHARACTERS) {
        throw new DocumentProcessingError('text_too_large');
      }
      const chunks = await semanticChunk(parsed.units, this.dependencies.embedTexts) as ReadyChunk[];
      const updated = this.db.transaction(() => (
        this.repo.replaceChunksAndMarkReady(record.id, chunks, parsed.characterCount)
      ))();
      await this.dependencies.publishChunks?.(this.repo.listChunks(record.id, 300, 0).items);
      return updated;
    } catch (error) {
      const failureCode = error instanceof DocumentProcessingError
        || error instanceof DocumentParserError
        || error instanceof ChunkingError
        ? error.failureCode
        : 'processing_failed';
      return this.db.transaction(() => this.repo.markFailed(record.id, failureCode))();
    }
  }

  private validateUpload(fileName: string, mimeType: string, buffer: Buffer): DocumentFormat {
    if (buffer.byteLength === 0) throw new ValidationError('Document is empty');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new ValidationError('Document exceeds the 10 MB limit');
    const extension = path.extname(fileName).slice(1).toLowerCase() as DocumentFormat;
    const allowedMimeTypes: Record<DocumentFormat, string[]> = {
      txt: ['text/plain'],
      md: ['text/markdown', 'text/x-markdown', 'text/plain'],
      pdf: ['application/pdf'],
      docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    };
    if (!(extension in allowedMimeTypes)) throw new ValidationError('Unsupported document format');
    if (!allowedMimeTypes[extension].includes(mimeType)) {
      throw new ValidationError('File type does not match its extension');
    }
    if (extension === 'txt' || extension === 'md') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new ValidationError('Text documents must use UTF-8');
      }
      if (buffer.includes(0)) throw new ValidationError('Text document content is invalid');
    }
    if (extension === 'pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new ValidationError('PDF signature is invalid');
    }
    if (extension === 'docx' && (buffer[0] !== 0x50 || buffer[1] !== 0x4b)) {
      throw new ValidationError('DOCX signature is invalid');
    }
    return extension;
  }

  private requireDocument(documentId: string): DocumentRecord {
    const record = this.repo.findById(documentId);
    if (!record) throw new NotFoundError('Document not found');
    return record;
  }

  private resolveStoragePath(storagePath: string): string {
    return path.join(this.dependencies.uploadDir, path.basename(storagePath));
  }

  private toPublicDocument(record: DocumentRecord): Document {
    const { storagePath: _storagePath, sha256: _sha256, ...document } = record;
    return document;
  }
}

class DocumentProcessingError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}
