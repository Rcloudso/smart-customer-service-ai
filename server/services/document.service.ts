import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  ChunkingError,
  DOCUMENT_CHUNKER_VERSION,
  SemanticChunkPlan,
  semanticChunkPlan,
} from '../ai/document-chunker';
import {
  DOCUMENT_CLEANER_VERSION,
  cleanNormalizedStructuredDocument,
  evaluateDocumentQuality,
  normalizeStructuredDocument,
} from '../ai/document-cleaner';
import {
  DOCUMENT_IR_VERSION,
  DocumentBlock,
  DocumentIRValidationError,
  StructuredDocument,
} from '../ai/document-ir';
import { DocumentParserError, parseDocument } from '../ai/document-parser';
import { structuredDocumentToSemanticUnits } from '../ai/document-parser-adapter';
import {
  OcrExtractionError,
  OcrExtractor,
} from '../ai/ocr-extractor';
import {
  DOCUMENT_EMBEDDING_INPUT_VERSION,
  buildDocumentEmbeddingText,
  currentEmbeddingProfile,
} from '../ai/embedding-profile';
import { DocumentRepo } from '../db/repos/document.repo';
import {
  DocumentReviewBlock,
  DocumentReviewRepo,
  OcrExtractionJob,
} from '../db/repos/document-review.repo';
import {
  Document,
  DocumentDetail,
  DocumentChunk,
  DocumentChunkView,
  DocumentFormat,
  DocumentRecord,
  DocumentStatus,
  DocumentProcessingStageName,
  ParsedDocumentFormat,
  VisualDocumentFormat,
} from '../types/domain';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 200_000;
const PROCESSING_STAGES: Record<DocumentProcessingStageName, number> = {
  validate: 0,
  parse: 1,
  normalize: 2,
  clean: 3,
  quality_gate: 4,
  chunk: 5,
  embed: 6,
  publish: 7,
};

export interface DocumentServiceDependencies {
  uploadDir: string;
  embedTexts: (texts: string[]) => Promise<number[][]>;
  authoritativeOcr?: OcrExtractor;
  publishChunks?: (
    chunks: DocumentChunk[],
    document: Pick<DocumentRecord, 'id' | 'fileName'>,
  ) => void | Promise<void>;
  removeDocumentFromIndex?: (documentId: string, chunks: DocumentChunk[]) => void | Promise<void>;
  synchronizeIndex?: () => void | Promise<void>;
}

export class DocumentService {
  private readonly repo: DocumentRepo;
  private readonly reviewRepo: DocumentReviewRepo;

  constructor(
    private readonly db: Database.Database,
    private readonly dependencies: DocumentServiceDependencies,
  ) {
    this.repo = new DocumentRepo(db);
    this.reviewRepo = new DocumentReviewRepo(db);
  }

  async upload(params: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    uploadedBy: string;
  }): Promise<Document> {
    const operationId = uuidv4();
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
      this.removeFileSafely(temporaryPath, operationId, 'upload_temporary_cleanup');
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
      this.removeFileSafely(finalPath, operationId, 'upload_accepted_file_cleanup');
      throw error;
    }

    const processed = isVisualDocumentFormat(format)
      ? await this.processVisual(record, params.buffer)
      : await this.process(record, params.buffer);
    return this.toPublicDocument(processed);
  }

  get(documentId: string): DocumentDetail {
    const record = this.requireDocument(documentId);
    return {
      ...this.toPublicDocument(record),
      processingSummary: this.repo.getProcessingSummary(record.latestTaskId),
      representationSummary: this.repo.getRepresentationSummary(record.latestRepresentationId),
      extractionSummary: this.toExtractionSummary(
        this.reviewRepo.findLatestExtractionJob(documentId),
      ),
      reviewDraftSummary: this.reviewRepo.findLatestDraftSummary(documentId),
    };
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
      items: result.items.map(({
        embedding: _embedding,
        embeddingProfile: _embeddingProfile,
        ...chunk
      }) => chunk),
      total: result.total,
    };
  }

  listBlocks(documentId: string, params: { page: number; pageSize: number }): {
    items: DocumentBlock[];
    total: number;
    representationVersion: string | null;
  } {
    const record = this.requireDocument(documentId);
    if (!record.latestRepresentationId) {
      return { items: [], total: 0, representationVersion: record.representationVersion };
    }
    const result = this.repo.listRepresentationBlocks(
      record.latestRepresentationId,
      params.pageSize,
      (params.page - 1) * params.pageSize,
    );
    return {
      ...result,
      representationVersion: record.representationVersion,
    };
  }

  listReviewDraftBlocks(documentId: string, params: { page: number; pageSize: number }): {
    draftId: string | null;
    revision: number | null;
    status: 'open' | 'published' | 'superseded' | null;
    items: DocumentReviewBlock[];
    total: number;
  } {
    this.requireDocument(documentId);
    const result = this.reviewRepo.listLatestDraftBlocks(
      documentId,
      params.pageSize,
      (params.page - 1) * params.pageSize,
    );
    if (!result) {
      return {
        draftId: null,
        revision: null,
        status: null,
        items: [],
        total: 0,
      };
    }
    return {
      draftId: result.draft.id,
      revision: result.draft.revision,
      status: result.draft.status,
      items: result.items,
      total: result.total,
    };
  }

  async retry(documentId: string): Promise<Document> {
    let record = this.requireDocument(documentId);
    if (record.status !== 'failed') throw new ConflictError('Only failed documents can be retried');
    const retryOf = isVisualDocumentFormat(record.format)
      ? this.reviewRepo.findLatestExtractionJob(documentId)?.id ?? null
      : record.latestTaskId;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.resolveStoragePath(record.storagePath));
    } catch {
      const taskId = this.repo.createProcessingTask({
        documentId,
        sourceVersion: record.sourceVersion,
        retryOf,
        inputBytes: 0,
      });
      this.repo.startProcessingStage(taskId, 'validate', PROCESSING_STAGES.validate, 0);
      this.repo.failProcessingStage(taskId, 'validate', 'source_file_missing');
      this.db.transaction(() => this.repo.markFailed(documentId, 'source_file_missing', {
        taskId,
        representationId: record.latestRepresentationId,
        representationVersion: record.representationVersion,
        parserVersion: record.parserVersion,
        cleanerVersion: record.cleanerVersion,
        chunkerVersion: record.chunkerVersion,
        qualityDecision: record.qualityDecision,
        qualityReasons: record.qualityReasons,
        indexStatus: 'failed',
      }))();
      this.repo.completeProcessingTask({
        taskId,
        representationVersion: record.representationVersion,
        parserVersion: record.parserVersion,
        cleanerVersion: record.cleanerVersion,
        chunkerVersion: record.chunkerVersion,
        qualityDecision: record.qualityDecision,
        qualityReasons: record.qualityReasons,
        failureCode: 'source_file_missing',
        indexStatus: 'failed',
        outputCharacters: 0,
        blockCount: 0,
        chunkCount: 0,
        succeeded: false,
      });
      return this.toPublicDocument(this.requireDocument(documentId));
    }
    record = this.repo.markPending(documentId);
    const processed = isVisualDocumentFormat(record.format)
      ? await this.processVisual(record, buffer, { retryOf })
      : await this.process(record, buffer, { retryOf });
    return this.toPublicDocument(processed);
  }

  async reprocess(documentId: string): Promise<DocumentDetail> {
    const record = this.requireDocument(documentId);
    if (record.status !== 'ready') {
      throw new ConflictError('Only ready documents can be reprocessed');
    }
    if (isVisualDocumentFormat(record.format)) {
      throw new ConflictError('Reviewed OCR documents must be re-extracted through the review workflow');
    }
    if (
      record.representationVersion === DOCUMENT_IR_VERSION
      && record.cleanerVersion === DOCUMENT_CLEANER_VERSION
      && record.chunkerVersion === DOCUMENT_CHUNKER_VERSION
      && record.indexStatus === 'published'
    ) {
      return this.get(documentId);
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.resolveStoragePath(record.storagePath));
    } catch {
      throw new ServiceUnavailableError('Document source file is unavailable');
    }
    await this.process(record, buffer, {
      shadow: true,
      retryOf: record.latestTaskId,
    });
    return this.get(documentId);
  }

  async setActive(documentId: string, isActive: boolean): Promise<Document> {
    const record = this.requireDocument(documentId);
    if (record.status !== 'ready') throw new ConflictError('Only ready documents can be activated or deactivated');
    const updated = this.repo.setActive(documentId, Number(isActive));
    const chunks = this.repo.listChunks(documentId, 300, 0).items;
    try {
      if (isActive) {
        await this.dependencies.publishChunks?.(chunks, record);
      } else {
        await this.dependencies.removeDocumentFromIndex?.(documentId, chunks);
      }
    } catch (error) {
      this.repo.setActive(documentId, record.isActive);
      try {
        if (record.isActive) {
          await this.dependencies.publishChunks?.(chunks, record);
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
    const operationId = uuidv4();
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
      await this.synchronizeDocumentIndex('remove', record, chunks);
      this.db.transaction(() => {
        if (!this.repo.delete(documentId)) throw new Error('Document delete did not change a row');
        if (renamed) fs.rmSync(temporaryPath);
      })();
      databaseDeleted = true;
    } catch (error) {
      let databaseRestored = !databaseDeleted;
      if (databaseDeleted) {
        try {
          this.db.transaction(() => this.repo.restore(record, chunks))();
          databaseRestored = true;
        } catch (restoreError) {
          logger.error({
            operationId,
            documentId,
            errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
          }, 'Document delete database compensation failed');
        }
      }
      let fileRestored = !renamed;
      try {
        if (renamed && fs.existsSync(temporaryPath)) {
          fs.renameSync(temporaryPath, filePath);
          fileRestored = true;
        }
      } catch (restoreError) {
        logger.error({
          operationId,
          documentId,
          errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
        }, 'Document delete file compensation failed');
      }
      let indexRestored = false;
      if (databaseRestored && fileRestored) {
        try {
          await this.synchronizeDocumentIndex('restore', record, chunks);
          indexRestored = true;
        } catch (restoreError) {
          logger.error({
            operationId,
            documentId,
            errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
          }, 'Document delete index compensation failed');
        }
      }
      if (!databaseRestored || !fileRestored || !indexRestored) {
        await this.convergeFailedDeleteToRemovedState({
          operationId,
          documentId,
          filePath,
          temporaryPath,
          record,
          chunks,
        });
      }
      throw error instanceof ConflictError || error instanceof NotFoundError
        ? error
        : new ServiceUnavailableError('Document deletion could not be completed');
    }
  }

  private async processVisual(
    record: DocumentRecord,
    buffer: Buffer,
    options: { retryOf?: string | null } = {},
  ): Promise<DocumentRecord> {
    const extractor = this.dependencies.authoritativeOcr;
    if (!extractor) {
      return this.db.transaction(() => this.repo.markFailed(
        record.id,
        'ocr_worker_unconfigured',
        {
          qualityDecision: null,
          qualityReasons: [],
          indexStatus: 'not_indexed',
        },
      ))();
    }

    const job = this.reviewRepo.createExtractionJob({
      documentId: record.id,
      sourceVersion: record.sourceVersion,
      role: 'authoritative',
      engine: extractor.engine,
      engineVersion: extractor.engineVersion,
      retryOf: options.retryOf,
    });
    this.reviewRepo.startExtractionJob(job.id);

    try {
      const result = await extractor.extract({
        requestId: job.id,
        documentId: record.id,
        sourceVersion: record.sourceVersion,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sha256: record.sha256,
        buffer,
      });
      this.db.transaction(() => {
        this.reviewRepo.completeExtractionJob(job.id, result);
        this.reviewRepo.createDraftFromAuthoritativeJob(job.id, record.uploadedBy);
        this.repo.markFailed(record.id, 'ocr_review_required', {
          parserVersion: `${result.engine.name}:${result.engine.version}`,
          qualityDecision: 'review_required',
          qualityReasons: ['ocr_review_required'],
          indexStatus: 'not_indexed',
        });
      })();
      return this.requireDocument(record.id);
    } catch (error) {
      const failureCode = error instanceof OcrExtractionError
        ? error.failureCode
        : 'ocr_worker_unavailable';
      logger.warn({
        documentId: record.id,
        jobId: job.id,
        engine: extractor.engine,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Document OCR extraction failed');
      this.db.transaction(() => {
        this.reviewRepo.failExtractionJob(job.id, failureCode);
        this.repo.markFailed(record.id, failureCode, {
          qualityDecision: null,
          qualityReasons: [],
          indexStatus: 'not_indexed',
        });
      })();
      return this.requireDocument(record.id);
    }
  }

  private async process(
    record: DocumentRecord,
    buffer: Buffer,
    options: { shadow?: boolean; retryOf?: string | null } = {},
  ): Promise<DocumentRecord> {
    if (isVisualDocumentFormat(record.format)) {
      throw new DocumentProcessingError('ocr_required');
    }
    const parsedFormat: ParsedDocumentFormat = record.format;
    const previousChunks = options.shadow
      ? this.repo.listChunks(record.id, 300, 0).items
      : [];
    const taskId = this.repo.createProcessingTask({
      documentId: record.id,
      sourceVersion: record.sourceVersion,
      retryOf: options.retryOf,
      inputBytes: buffer.byteLength,
    });
    let representation: StructuredDocument | null = null;
    let representationId: string | null = null;
    let qualityDecision: 'ready' | 'review_required' | 'rejected' | null = null;
    let qualityReasons: string[] = [];
    let plans: SemanticChunkPlan[] = [];
    let databaseReplaced = false;
    try {
      await this.runStage(taskId, 'validate', buffer.byteLength, async () => {
        const format = this.validateUpload(record.fileName, record.mimeType, buffer);
        if (format !== record.format) throw new DocumentProcessingError('format_changed');
        return 1;
      }, (count) => count);

      const parsed = await this.runStage(taskId, 'parse', buffer.byteLength, () => (
        parseDocument(buffer, parsedFormat, {
          documentId: record.id,
          sourceVersion: record.sourceVersion,
          fileName: record.fileName,
          mimeType: record.mimeType,
          sha256: record.sha256,
        })
      ), (result) => result.representation.blocks.length);
      if (parsed.representation.metrics.inputCharacters > MAX_EXTRACTED_CHARACTERS) {
        throw new DocumentProcessingError('text_too_large');
      }

      const normalized = await this.runStage(
        taskId,
        'normalize',
        parsed.representation.metrics.inputCharacters,
        () => normalizeStructuredDocument(parsed.representation),
        (result) => result.metrics.normalizedCharacters,
      );

      const cleaned = await this.runStage(
        taskId,
        'clean',
        normalized.blocks.length,
        () => {
          const result = cleanNormalizedStructuredDocument(normalized);
          const id = this.repo.saveRepresentation(
            record.id,
            taskId,
            DOCUMENT_CLEANER_VERSION,
            result,
          );
          return { result, id };
        },
        ({ result }) => result.metrics.includedBlockCount,
      );
      representation = cleaned.result;
      representationId = cleaned.id;

      const quality = await this.runStage(
        taskId,
        'quality_gate',
        representation.metrics.includedCharacters,
        () => evaluateDocumentQuality(representation as StructuredDocument),
        () => 1,
      );
      qualityDecision = quality.decision;
      qualityReasons = quality.reasons;
      if (quality.decision !== 'ready') {
        const failureCode = quality.decision === 'review_required'
          ? 'quality_review_required'
          : `quality_rejected_${quality.reasons[0] ?? 'empty_content'}`;
        if (!options.shadow) {
          this.db.transaction(() => this.repo.markFailed(record.id, failureCode, {
            taskId,
            representationId,
            representationVersion: representation?.schemaVersion ?? null,
            parserVersion: representation?.parser.version ?? null,
            cleanerVersion: DOCUMENT_CLEANER_VERSION,
            chunkerVersion: DOCUMENT_CHUNKER_VERSION,
            qualityDecision,
            qualityReasons,
            indexStatus: 'not_indexed',
          }))();
        }
        this.repo.completeProcessingTask({
          taskId,
          representationVersion: representation.schemaVersion,
          parserVersion: representation.parser.version,
          cleanerVersion: DOCUMENT_CLEANER_VERSION,
          chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          qualityDecision,
          qualityReasons,
          failureCode,
          indexStatus: 'not_indexed',
          outputCharacters: representation.metrics.includedCharacters,
          blockCount: representation.blocks.length,
          chunkCount: 0,
          succeeded: false,
        });
        return this.requireDocument(record.id);
      }

      const units = chunkableUnits(representation);
      plans = await this.runStage(
        taskId,
        'chunk',
        units.length,
        () => semanticChunkPlan(
          units,
          (texts) => this.embedTextsSafely(record, texts),
          record.fileName,
          {
            representationVersion: DOCUMENT_IR_VERSION,
            chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          },
        ),
        (result) => result.length,
      );

      const embeddings = await this.runStage(
        taskId,
        'embed',
        plans.length,
        () => this.embedTextsSafely(record, plans.map((chunk) => (
          buildDocumentEmbeddingText({
            documentTitle: record.fileName,
            sectionTitle: chunk.title,
            content: chunk.content,
          })
        ))),
        (result) => result.length,
      );
      if (
        embeddings.length !== plans.length
        || embeddings.some((embedding) => embedding.length === 0)
      ) {
        throw new ChunkingError('embedding_failed');
      }
      const now = new Date().toISOString();
      const chunks: DocumentChunk[] = plans.map((plan, index) => ({
        ...plan,
        id: uuidv4(),
        documentId: record.id,
        embedding: embeddings[index],
        embeddingProfile: currentEmbeddingProfile(DOCUMENT_EMBEDDING_INPUT_VERSION),
        createdAt: now,
      }));

      try {
        await this.runStage(
          taskId,
          'publish',
          chunks.length,
          async () => {
            const publication = this.dependencies.publishChunks?.(chunks, record);
            if (publication && typeof publication.then === 'function') {
              await publication;
            }
            this.db.transaction(() => this.repo.replaceChunksAndMarkReady(
              record.id,
              chunks,
              representation?.metrics.includedCharacters ?? 0,
              {
                taskId,
                representationId: representationId as string,
                representationVersion: DOCUMENT_IR_VERSION,
                parserVersion: representation?.parser.version ?? 'unknown',
                cleanerVersion: DOCUMENT_CLEANER_VERSION,
                chunkerVersion: DOCUMENT_CHUNKER_VERSION,
                qualityDecision: 'ready',
                qualityReasons: [],
                indexStatus: 'published',
              },
            ))();
            databaseReplaced = true;
            return chunks.length;
          },
          (count) => count,
        );
        this.repo.completeProcessingTask({
          taskId,
          representationVersion: representation.schemaVersion,
          parserVersion: representation.parser.version,
          cleanerVersion: DOCUMENT_CLEANER_VERSION,
          chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          qualityDecision: 'ready',
          qualityReasons: [],
          failureCode: null,
          indexStatus: 'published',
          outputCharacters: representation.metrics.includedCharacters,
          blockCount: representation.blocks.length,
          chunkCount: chunks.length,
          succeeded: true,
        });
      } catch (error) {
        await this.compensatePublishFailure({
          record,
          previousChunks,
          taskId,
          representationId,
          representation,
          qualityDecision,
          qualityReasons,
          shadow: Boolean(options.shadow),
          databaseReplaced,
        });
        return this.requireDocument(record.id);
      }
      return this.requireDocument(record.id);
    } catch (error) {
      const parserRejected = error instanceof DocumentParserError
        || error instanceof DocumentIRValidationError;
      const unsafeStructure = error instanceof ChunkingError
        && error.failureCode === 'structural_unit_too_large';
      const failureCode = unsafeStructure
        ? 'quality_review_required'
        : processingFailureCode(error);
      const resolvedQualityDecision = parserRejected
        ? 'rejected'
        : unsafeStructure
          ? 'review_required'
          : qualityDecision;
      const resolvedQualityReasons = parserRejected
        ? []
        : unsafeStructure
          ? ['unsupported_structure']
          : qualityReasons;
      if (!options.shadow) {
        this.db.transaction(() => this.repo.markFailed(record.id, failureCode, {
          taskId,
          representationId,
          representationVersion: representation?.schemaVersion ?? null,
          parserVersion: representation?.parser.version ?? null,
          cleanerVersion: representation ? DOCUMENT_CLEANER_VERSION : null,
          chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          qualityDecision: resolvedQualityDecision,
          qualityReasons: resolvedQualityReasons,
          indexStatus: 'failed',
        }))();
      }
      this.repo.completeProcessingTask({
        taskId,
        representationVersion: representation?.schemaVersion ?? null,
        parserVersion: representation?.parser.version ?? null,
        cleanerVersion: representation ? DOCUMENT_CLEANER_VERSION : null,
        chunkerVersion: DOCUMENT_CHUNKER_VERSION,
        qualityDecision: resolvedQualityDecision,
        qualityReasons: resolvedQualityReasons,
        failureCode,
        indexStatus: 'failed',
        outputCharacters: representation?.metrics.includedCharacters ?? 0,
        blockCount: representation?.blocks.length ?? 0,
        chunkCount: plans.length,
        succeeded: false,
      });
      return this.requireDocument(record.id);
    }
  }

  private async runStage<T>(
    taskId: string,
    name: DocumentProcessingStageName,
    inputCount: number | null,
    operation: () => T | Promise<T>,
    outputCount: (result: T) => number | null,
  ): Promise<T> {
    this.repo.startProcessingStage(taskId, name, PROCESSING_STAGES[name], inputCount);
    try {
      const result = await operation();
      this.repo.completeProcessingStage(taskId, name, outputCount(result));
      return result;
    } catch (error) {
      this.repo.failProcessingStage(taskId, name, processingFailureCode(error));
      throw error;
    }
  }

  private async embedTextsSafely(record: DocumentRecord, texts: string[]): Promise<number[][]> {
    try {
      return await this.dependencies.embedTexts(texts);
    } catch (error) {
      logger.warn({
        documentId: record.id,
        format: record.format,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Document embedding failed');
      throw new ChunkingError('embedding_failed');
    }
  }

  private async compensatePublishFailure(params: {
    record: DocumentRecord;
    previousChunks: DocumentChunk[];
    taskId: string;
    representationId: string | null;
    representation: StructuredDocument;
    qualityDecision: 'ready' | 'review_required' | 'rejected' | null;
    qualityReasons: string[];
    shadow: boolean;
    databaseReplaced: boolean;
  }): Promise<void> {
    let databaseKnown = true;
    try {
      if (params.shadow && params.databaseReplaced) {
        this.repo.restorePublishedState(params.record, params.previousChunks, params.taskId);
      } else if (!params.shadow) {
        this.db.transaction(() => this.repo.markFailed(params.record.id, 'publish_failed', {
          taskId: params.taskId,
          representationId: params.representationId,
          representationVersion: params.representation.schemaVersion,
          parserVersion: params.representation.parser.version,
          cleanerVersion: DOCUMENT_CLEANER_VERSION,
          chunkerVersion: DOCUMENT_CHUNKER_VERSION,
          qualityDecision: params.qualityDecision,
          qualityReasons: params.qualityReasons,
          indexStatus: 'failed',
        }))();
      }
    } catch (error) {
      databaseKnown = false;
      logger.error({
        documentId: params.record.id,
        taskId: params.taskId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Document publish compensation database restoration failed');
      try {
        this.repo.setIndexStatus(params.record.id, 'failed', 0);
      } catch {
        // The reconciliation result remains false when even disabling cannot be persisted.
      }
    }
    let reconciled = false;
    if (databaseKnown && this.dependencies.synchronizeIndex) {
      try {
        await this.dependencies.synchronizeIndex();
        reconciled = true;
      } catch (error) {
        logger.error({
          documentId: params.record.id,
          taskId: params.taskId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Document publish compensation index synchronization failed');
      }
    }
    if (!reconciled && databaseKnown && !this.dependencies.synchronizeIndex) {
      try {
        if (params.shadow && params.record.isActive && this.dependencies.publishChunks) {
          await this.dependencies.publishChunks?.(params.previousChunks, params.record);
          reconciled = true;
        } else if (this.dependencies.removeDocumentFromIndex) {
          await this.dependencies.removeDocumentFromIndex(params.record.id, []);
          reconciled = true;
        }
      } catch {
        // The document is disabled below when index convergence is unknown.
      }
    }
    if (!reconciled) {
      try {
        this.repo.setIndexStatus(params.record.id, 'failed', 0);
      } catch {
        // The task record below still preserves the safe error code when possible.
      }
    }
    this.repo.completeProcessingTask({
      taskId: params.taskId,
      representationVersion: params.representation.schemaVersion,
      parserVersion: params.representation.parser.version,
      cleanerVersion: DOCUMENT_CLEANER_VERSION,
      chunkerVersion: DOCUMENT_CHUNKER_VERSION,
      qualityDecision: params.qualityDecision,
      qualityReasons: params.qualityReasons,
      failureCode: 'publish_failed',
      indexStatus: reconciled && params.shadow ? params.record.indexStatus : 'failed',
      outputCharacters: params.representation.metrics.includedCharacters,
      blockCount: params.representation.blocks.length,
      chunkCount: 0,
      succeeded: false,
    });
  }

  private validateUpload(fileName: string, mimeType: string, buffer: Buffer): DocumentFormat {
    if (buffer.byteLength === 0) throw new ValidationError('Document is empty');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new ValidationError('Document exceeds the 10 MB limit');
    const rawExtension = path.extname(fileName).slice(1).toLowerCase();
    const extension = (rawExtension === 'jpg' ? 'jpeg' : rawExtension) as DocumentFormat;
    const allowedMimeTypes: Record<DocumentFormat, string[]> = {
      txt: ['text/plain'],
      md: ['text/markdown', 'text/x-markdown', 'text/plain'],
      pdf: ['application/pdf'],
      docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      png: ['image/png'],
      jpeg: ['image/jpeg'],
      webp: ['image/webp'],
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
    if (
      extension === 'png'
      && !buffer.subarray(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]))
    ) {
      throw new ValidationError('PNG signature is invalid');
    }
    if (
      extension === 'jpeg'
      && !buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    ) {
      throw new ValidationError('JPEG signature is invalid');
    }
    if (
      extension === 'webp'
      && (
        buffer.length < 12
        || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
        || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
      )
    ) {
      throw new ValidationError('WebP signature is invalid');
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

  private async convergeFailedDeleteToRemovedState(params: {
    operationId: string;
    documentId: string;
    filePath: string;
    temporaryPath: string;
    record: DocumentRecord;
    chunks: DocumentChunk[];
  }): Promise<void> {
    let databaseRemoved = false;
    try {
      databaseRemoved = !this.repo.findById(params.documentId) || this.repo.delete(params.documentId);
    } catch (cleanupError) {
      logger.error({
        operationId: params.operationId,
        documentId: params.documentId,
        errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
      }, 'Document delete database convergence failed');
    }
    if (!databaseRemoved) {
      let fileRestored = fs.existsSync(params.filePath);
      try {
        if (!fileRestored && fs.existsSync(params.temporaryPath)) {
          fs.renameSync(params.temporaryPath, params.filePath);
          fileRestored = true;
        }
      } catch (cleanupError) {
        logger.error({
          operationId: params.operationId,
          documentId: params.documentId,
          errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
        }, 'Document delete file rollback after convergence failure failed');
      }
      let currentRecord = this.repo.findById(params.documentId) ?? params.record;
      if (!fileRestored && currentRecord.isActive) {
        try {
          currentRecord = this.repo.setActive(params.documentId, 0);
        } catch (disableError) {
          logger.error({
            operationId: params.operationId,
            documentId: params.documentId,
            errorName: disableError instanceof Error ? disableError.name : 'UnknownError',
          }, 'Document disable after file rollback failure failed');
        }
      }
      try {
        await this.synchronizeDocumentIndex('restore', currentRecord, params.chunks);
      } catch (cleanupError) {
        if (currentRecord.isActive) {
          try {
            currentRecord = this.repo.setActive(params.documentId, 0);
            await this.synchronizeDocumentIndex('restore', currentRecord, params.chunks);
          } catch (disableError) {
            logger.error({
              operationId: params.operationId,
              documentId: params.documentId,
              errorName: disableError instanceof Error ? disableError.name : 'UnknownError',
            }, 'Document disable and index reconciliation failed');
          }
        }
        logger.error({
          operationId: params.operationId,
          documentId: params.documentId,
          errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
        }, 'Document delete index rollback after convergence failure failed');
      }
      return;
    }
    try {
      await this.synchronizeDocumentIndex('remove', params.record, params.chunks);
    } catch (cleanupError) {
      logger.error({
        operationId: params.operationId,
        documentId: params.documentId,
        errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
      }, 'Document delete index convergence failed');
      let databaseRestored = false;
      try {
        this.db.transaction(() => this.repo.restore(params.record, params.chunks))();
        databaseRestored = true;
      } catch (restoreError) {
        logger.error({
          operationId: params.operationId,
          documentId: params.documentId,
          errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
        }, 'Document restore after index convergence failure failed');
      }
      let fileRestored = fs.existsSync(params.filePath);
      try {
        if (!fileRestored && fs.existsSync(params.temporaryPath)) {
          fs.renameSync(params.temporaryPath, params.filePath);
          fileRestored = true;
        }
      } catch (restoreError) {
        logger.error({
          operationId: params.operationId,
          documentId: params.documentId,
          errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
        }, 'Document file restore after index convergence failure failed');
      }
      if (databaseRestored) {
        let restoredRecord = this.repo.findById(params.documentId) ?? params.record;
        if (!fileRestored && restoredRecord.isActive) {
          try {
            restoredRecord = this.repo.setActive(params.documentId, 0);
          } catch (disableError) {
            logger.error({
              operationId: params.operationId,
              documentId: params.documentId,
              errorName: disableError instanceof Error ? disableError.name : 'UnknownError',
            }, 'Document disable after failed file restore failed');
          }
        }
        try {
          await this.synchronizeDocumentIndex('restore', restoredRecord, params.chunks);
        } catch (restoreError) {
          if (restoredRecord.isActive) {
            try {
              restoredRecord = this.repo.setActive(params.documentId, 0);
              await this.synchronizeDocumentIndex('restore', restoredRecord, params.chunks);
            } catch (disableError) {
              logger.error({
                operationId: params.operationId,
                documentId: params.documentId,
                errorName: disableError instanceof Error ? disableError.name : 'UnknownError',
              }, 'Document disable after index convergence restore failure failed');
            }
          }
          logger.error({
            operationId: params.operationId,
            documentId: params.documentId,
            errorName: restoreError instanceof Error ? restoreError.name : 'UnknownError',
          }, 'Document index restore after convergence failure failed');
        }
      }
      return;
    }
    this.removeFileSafely(params.filePath, params.operationId, 'delete_file_convergence');
    this.removeFileSafely(params.temporaryPath, params.operationId, 'delete_temporary_convergence');
  }

  private async synchronizeDocumentIndex(
    mode: 'remove' | 'restore',
    record: DocumentRecord,
    chunks: DocumentChunk[],
  ): Promise<void> {
    if (this.dependencies.synchronizeIndex) {
      await this.dependencies.synchronizeIndex();
      return;
    }
    if (mode === 'remove' || !record.isActive) {
      await this.dependencies.removeDocumentFromIndex?.(record.id, chunks);
    } else {
      await this.dependencies.publishChunks?.(chunks, record);
    }
  }

  private removeFileSafely(filePath: string, operationId: string, operation: string): boolean {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch (cleanupError) {
      logger.error({
        operationId,
        operation,
        errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
      }, 'Document file cleanup failed');
      return false;
    }
  }

  private toPublicDocument(record: DocumentRecord): Document {
    const { storagePath: _storagePath, sha256: _sha256, ...document } = record;
    return document;
  }

  private toExtractionSummary(
    job: OcrExtractionJob | null,
  ): DocumentDetail['extractionSummary'] {
    if (!job) return null;
    return {
      jobId: job.id,
      status: job.status,
      role: job.role,
      engine: job.engine,
      engineVersion: job.engineVersion,
      retryOf: job.retryOf,
      errorCode: job.errorCode,
      blockCount: job.result?.blocks.length ?? 0,
      warningCodes: job.result?.warnings.map((warning) => warning.code) ?? [],
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

}

class DocumentProcessingError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}

function isVisualDocumentFormat(format: DocumentFormat): format is VisualDocumentFormat {
  return format === 'png' || format === 'jpeg' || format === 'webp';
}

function processingFailureCode(error: unknown): string {
  return error instanceof DocumentProcessingError
    || error instanceof DocumentParserError
    || error instanceof DocumentIRValidationError
    || error instanceof ChunkingError
    ? error.failureCode
    : 'processing_failed';
}

function chunkableUnits(representation: StructuredDocument) {
  const units = structuredDocumentToSemanticUnits(representation);
  const referencedHeadingIds = new Set(units.flatMap((unit) => (
    unit.blockKind === 'heading' ? [] : unit.sourceBlockIds ?? []
  )));
  return units.filter((unit) => {
    if (unit.blockKind !== 'heading') return true;
    const ownId = unit.sourceBlockIds?.at(-1);
    return !ownId || !referencedHeadingIds.has(ownId);
  });
}
