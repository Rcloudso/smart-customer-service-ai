import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { QdrantClient, withHeaders } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { RetrievalIndexJobRepo } from '../db/repos/retrieval-index-job.repo';
import { RetrievalIndexKnowledgeRepo } from '../db/repos/retrieval-index-knowledge.repo';
import { QualityRunRepo } from '../db/repos/quality-run.repo';
import type { VectorRecord } from '../ai/vector-store';
import {
  QdrantRequestError,
  QdrantVectorStore,
} from '../ai/qdrant-vector-store';
import type {
  RetrievalActivationCheck,
  RetrievalIndexJob,
} from '../types/retrieval-ops';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { knowledgeFingerprint } from './knowledge-fingerprint';
import { qualityCandidateKey } from '../eval/quality-evaluator';

const INDEX_BATCH_SIZE = 100;

export interface QdrantCollectionInfo {
  dimensions: number;
  count: number;
}

export interface QdrantCollectionControl {
  createCollection(name: string, dimensions: number, traceId?: string): Promise<boolean>;
  collectionInfo(name: string, traceId?: string): Promise<QdrantCollectionInfo | null>;
  currentAliasCollection(traceId?: string): Promise<string | null>;
  switchAlias(
    nextCollection: string,
    expectedCurrent: string | null,
    traceId?: string,
  ): Promise<void>;
}

export interface RetrievalIndexVectorWriter {
  upsert(records: VectorRecord[], traceId?: string): Promise<void>;
}

interface RetrievalIndexJobServiceOptions {
  control?: QdrantCollectionControl;
  writerFactory?: (collection: string) => RetrievalIndexVectorWriter;
  collectionPrefix?: string;
  autoDrain?: boolean;
  now?: () => Date;
  activationGate?: (job: RetrievalIndexJob) => RetrievalActivationCheck;
}

export class RetrievalIndexJobService {
  private readonly repo: RetrievalIndexJobRepo;
  private readonly knowledgeRepo: RetrievalIndexKnowledgeRepo;
  private readonly qualityRunRepo: QualityRunRepo;
  private readonly control: QdrantCollectionControl;
  private readonly writerFactory: (collection: string) => RetrievalIndexVectorWriter;
  private readonly collectionPrefix: string;
  private readonly autoDrain: boolean;
  private readonly now: () => Date;
  private readonly configured: boolean;
  private draining = false;
  private readonly injectedActivationGate?: (
    job: RetrievalIndexJob,
  ) => RetrievalActivationCheck;

  constructor(
    private readonly db: Database.Database,
    options: RetrievalIndexJobServiceOptions = {},
  ) {
    this.repo = new RetrievalIndexJobRepo(db);
    this.knowledgeRepo = new RetrievalIndexKnowledgeRepo(db);
    this.qualityRunRepo = new QualityRunRepo(db);
    this.configured = Boolean(options.control) || config.vectorStore.provider === 'qdrant';
    this.control = options.control ?? (
      this.configured ? createQdrantCollectionControl() : unavailableQdrantControl()
    );
    this.writerFactory = options.writerFactory ?? ((collection) => {
      const store = new QdrantVectorStore({
        client: createQdrantClient(),
        collectionAlias: collection,
      });
      return { upsert: (records, traceId) => store.upsertBatch(records, traceId) };
    });
    this.collectionPrefix = options.collectionPrefix ?? config.vectorStore.collectionPrefix;
    this.autoDrain = options.autoDrain ?? true;
    this.now = options.now ?? (() => new Date());
    this.injectedActivationGate = options.activationGate;
  }

  start(): void {
    this.repo.interruptRunning(this.now().toISOString());
    if (this.configured) {
      queueMicrotask(() => void this.reconcilePendingIntent().catch((error) => {
        logger.warn({
          failureCode: safeIndexErrorCode(error),
        }, 'Pending retrieval alias operation could not be reconciled');
      }));
    }
    if (this.autoDrain) queueMicrotask(() => void this.drain());
  }

  async createJob(params: { createdBy: string }): Promise<RetrievalIndexJob> {
    this.requireQdrantConfigured();
    const snapshot = this.readSnapshotMetadata();
    const reusable = this.repo.findReusable(snapshot.fingerprint, snapshot.embeddingProfile);
    if (reusable) return reusable;
    const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
    const timestamp = this.now().toISOString().replace(/\D/g, '').slice(0, 14);
    const job = this.repo.create({
      collection: `${this.collectionPrefix}_${timestamp}_${suffix}`,
      embeddingProfile: snapshot.embeddingProfile,
      vectorDimension: snapshot.vectorDimension,
      knowledgeFingerprint: snapshot.fingerprint,
      expectedCount: snapshot.count,
      createdBy: params.createdBy,
      now: this.now().toISOString(),
    });
    if (this.autoDrain) queueMicrotask(() => void this.drain());
    return job;
  }

  getJob(id: string): RetrievalIndexJob {
    let job = this.repo.get(id);
    if (!job) throw new NotFoundError('Retrieval index job not found');
    if (
      ['queued', 'interrupted', 'ready'].includes(job.status)
      && !this.repo.hasPendingIntent(job.id)
      && job.knowledgeFingerprint !== knowledgeFingerprint(this.db)
    ) {
      this.repo.markStale(job.id, this.now().toISOString());
      job = this.repo.get(id) as RetrievalIndexJob;
    }
    return job;
  }

  listJobs(page: number = 1, pageSize: number = 20): {
    items: RetrievalIndexJob[];
    total: number;
    page: number;
    pageSize: number;
  } {
    return {
      items: this.repo.list(pageSize, (page - 1) * pageSize).map((job) => (
        this.getJob(job.id)
      )),
      total: this.repo.count(),
      page,
      pageSize,
    };
  }

  async processNext(): Promise<void> {
    const pending = this.repo.nextPending();
    if (!pending) return;
    const traceId = uuidv4();
    const snapshot = this.readSnapshotMetadata();
    if (
      snapshot.fingerprint !== pending.knowledgeFingerprint
      || snapshot.embeddingProfile !== pending.embeddingProfile
      || snapshot.vectorDimension !== pending.vectorDimension
      || snapshot.count !== pending.expectedCount
    ) {
      this.repo.markStale(pending.id, this.now().toISOString());
      return;
    }
    if (!this.repo.markRunning(pending.id, this.now().toISOString())) return;
    try {
      const existing = await this.control.collectionInfo(pending.collection, traceId);
      if (!existing) {
        if (pending.checkpoint > 0) {
          throw new IndexJobError('qdrant_collection_missing');
        }
        await this.control.createCollection(
          pending.collection,
          pending.vectorDimension,
          traceId,
        );
      } else if (existing.dimensions !== pending.vectorDimension) {
        throw new IndexJobError('qdrant_dimension_mismatch');
      }
      const writer = this.writerFactory(pending.collection);
      let checkpoint = pending.checkpoint;
      let cursor = this.knowledgeRepo.cursorAt(checkpoint);
      while (checkpoint < pending.expectedCount) {
        const page = this.knowledgeRepo.readPage(cursor, INDEX_BATCH_SIZE);
        const batch = page.records;
        if (batch.length === 0) throw new IndexJobError('knowledge_batch_missing');
        await writer.upsert(batch, traceId);
        checkpoint += batch.length;
        cursor = page.nextCursor;
        this.repo.saveCheckpoint(
          pending.id,
          checkpoint,
          checkpoint,
          this.now().toISOString(),
        );
      }
      const verified = await this.control.collectionInfo(pending.collection, traceId);
      if (!verified) throw new IndexJobError('qdrant_collection_missing');
      if (verified.dimensions !== pending.vectorDimension) {
        throw new IndexJobError('qdrant_dimension_mismatch');
      }
      if (verified.count !== pending.expectedCount) {
        throw new IndexJobError('qdrant_point_count_mismatch');
      }
      if (knowledgeFingerprint(this.db) !== pending.knowledgeFingerprint) {
        this.repo.markStale(pending.id, this.now().toISOString());
        return;
      }
      this.repo.markReady(pending.id, this.now().toISOString());
    } catch (error) {
      const failureCode = safeIndexErrorCode(error);
      logger.warn({ traceId, jobId: pending.id, failureCode }, 'Retrieval index build failed');
      this.repo.markFailed(pending.id, failureCode, this.now().toISOString());
    }
  }

  activationCheck(id: string): RetrievalActivationCheck {
    const job = this.getJob(id);
    if (this.injectedActivationGate) return this.injectedActivationGate(job);
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (job.status !== 'ready') reasons.push('index_job_not_ready');
    if (job.knowledgeFingerprint !== knowledgeFingerprint(this.db)) {
      reasons.push('knowledge_fingerprint_changed');
    }
    const { QualityLabService } = require('./quality-lab.service') as typeof import(
      './quality-lab.service'
    );
    const qualityLab = new QualityLabService(this.db);
    const currentPolicy = qualityLab.getCurrentPolicy();
    const candidateKey = qualityCandidateKey(
      { provider: 'qdrant', indexJobId: id },
      currentPolicy.config,
    );
    const quality = this.qualityRunRepo.findLatestCompletedCandidate(candidateKey);
    if (!quality) {
      reasons.push('quality_run_required');
      return {
        eligible: false,
        warnings,
        reasons,
        qualityRunId: null,
        candidateKey: null,
      };
    }
    const { QualityRunService } = require('./quality-run.service') as typeof import(
      './quality-run.service'
    );
    const gate = new QualityRunService(this.db, {
      qualityLab,
      autoDrain: false,
      getIndexJob: (jobId) => this.getJob(jobId),
    }).checkBackendActivation(quality.runId, quality.candidateKey);
    reasons.push(...gate.reasons);
    warnings.push(...gate.warnings);
    return {
      eligible: reasons.length === 0,
      warnings: [...new Set(warnings)],
      reasons: [...new Set(reasons)],
      qualityRunId: quality.runId,
      candidateKey: quality.candidateKey,
    };
  }

  async activate(params: {
    id: string;
    expectedCurrentCollection: string | null;
    confirmLatencyWarning: boolean;
  }): Promise<RetrievalIndexJob> {
    const reconciled = await this.reconcilePendingIntent();
    if (reconciled?.id === params.id) return reconciled;
    const job = this.getJob(params.id);
    const gate = this.activationCheck(job.id);
    if (!gate.eligible) {
      throw new ConflictError(`Retrieval activation gate failed: ${gate.reasons.join(', ')}`);
    }
    if (gate.warnings.length > 0 && !params.confirmLatencyWarning) {
      throw new ConflictError('Retrieval activation requires latency warning confirmation');
    }
    const current = await this.control.currentAliasCollection(uuidv4());
    if (current !== params.expectedCurrentCollection) {
      throw new ConflictError('Qdrant alias changed; refresh before activating');
    }
    this.repo.prepareActivation(job.id, current, this.now().toISOString());
    await this.control.switchAlias(job.collection, current, uuidv4());
    this.repo.completeActivation(job.id, this.now().toISOString());
    return this.getJob(job.id);
  }

  async rollback(params: {
    id: string;
    expectedCurrentCollection: string;
  }): Promise<RetrievalIndexJob> {
    const pendingBeforeReconcile = this.repo.findPendingIntent();
    const reconciled = await this.reconcilePendingIntent();
    if (reconciled) {
      if (
        pendingBeforeReconcile?.intent === 'rollback'
        && pendingBeforeReconcile.job.id === params.id
      ) return reconciled;
      throw new ConflictError(
        'A pending retrieval alias operation was reconciled; refresh before rolling back',
      );
    }
    const job = this.getJob(params.id);
    if (job.status !== 'active' || !job.previousCollection) {
      throw new ConflictError('Active index job has no rollback target');
    }
    if (job.collection !== params.expectedCurrentCollection) {
      throw new ConflictError('Expected current collection does not match the active job');
    }
    const target = this.repo.findByCollection(job.previousCollection);
    if (!target || target.status !== 'rolled_back') {
      throw new ConflictError('Previous verified collection is unavailable');
    }
    if (target.knowledgeFingerprint !== knowledgeFingerprint(this.db)) {
      throw new ConflictError('Previous collection knowledge fingerprint is stale');
    }
    const current = await this.control.currentAliasCollection(uuidv4());
    if (current !== params.expectedCurrentCollection) {
      throw new ConflictError('Qdrant alias changed; refresh before rolling back');
    }
    this.repo.prepareRollback(job.id, this.now().toISOString());
    await this.control.switchAlias(target.collection, job.collection, uuidv4());
    this.repo.completeRollback(job.id, target.id, this.now().toISOString());
    return this.getJob(target.id);
  }

  async status(): Promise<{
    provider: 'memory' | 'qdrant';
    qdrantConfigured: boolean;
    qdrantHealth: 'healthy' | 'degraded' | 'unavailable' | 'not_configured';
    alias: string;
    collection: string | null;
    points: number | null;
    dimensions: number | null;
    syncStatus: 'synced' | 'stale' | 'not_configured';
  }> {
    if (!this.configured) {
      return {
        provider: config.vectorStore.provider,
        qdrantConfigured: false,
        qdrantHealth: 'not_configured',
        alias: config.vectorStore.collectionAlias,
        collection: null,
        points: null,
        dimensions: null,
        syncStatus: 'not_configured',
      };
    }
    try {
      const collection = await this.control.currentAliasCollection(uuidv4());
      const info = collection ? await this.control.collectionInfo(collection, uuidv4()) : null;
      const job = collection ? this.repo.findByCollection(collection) : null;
      return {
        provider: config.vectorStore.provider,
        qdrantConfigured: true,
        qdrantHealth: collection && info ? 'healthy' : 'degraded',
        alias: config.vectorStore.collectionAlias,
        collection,
        points: info?.count ?? null,
        dimensions: info?.dimensions ?? null,
        syncStatus: job?.knowledgeFingerprint === knowledgeFingerprint(this.db)
          ? 'synced'
          : 'stale',
      };
    } catch {
      return {
        provider: config.vectorStore.provider,
        qdrantConfigured: true,
        qdrantHealth: 'unavailable',
        alias: config.vectorStore.collectionAlias,
        collection: null,
        points: null,
        dimensions: null,
        syncStatus: 'stale',
      };
    }
  }

  private readSnapshotMetadata(): {
    fingerprint: string;
    embeddingProfile: string;
    vectorDimension: number;
    count: number;
  } {
    const metadata = this.knowledgeRepo.inspect(INDEX_BATCH_SIZE);
    const profileHash = createHash('sha256')
      .update(JSON.stringify(metadata.embeddingProfiles))
      .digest('hex')
      .slice(0, 16);
    return {
      fingerprint: knowledgeFingerprint(this.db),
      embeddingProfile: `combined:${profileHash}`,
      vectorDimension: metadata.vectorDimension,
      count: metadata.count,
    };
  }

  private async reconcilePendingIntent(): Promise<RetrievalIndexJob | null> {
    const pending = this.repo.findPendingIntent();
    if (!pending) return null;
    const current = await this.control.currentAliasCollection(uuidv4());
    if (pending.intent === 'activate') {
      if (current === pending.job.collection) {
        this.repo.completeActivation(pending.job.id, this.now().toISOString());
        return this.repo.get(pending.job.id);
      }
      if (current === pending.expectedCollection) {
        await this.control.switchAlias(
          pending.job.collection,
          pending.expectedCollection,
          uuidv4(),
        );
        this.repo.completeActivation(pending.job.id, this.now().toISOString());
        return this.repo.get(pending.job.id);
      }
      throw new ConflictError('Qdrant alias no longer matches the pending activation');
    }

    const target = pending.job.previousCollection
      ? this.repo.findByCollection(pending.job.previousCollection)
      : null;
    if (!target) {
      throw new ConflictError('Pending rollback target is unavailable');
    }
    if (current === target.collection) {
      this.repo.completeRollback(
        pending.job.id,
        target.id,
        this.now().toISOString(),
      );
      return this.repo.get(target.id);
    }
    if (current === pending.expectedCollection) {
      await this.control.switchAlias(
        target.collection,
        pending.expectedCollection,
        uuidv4(),
      );
      this.repo.completeRollback(
        pending.job.id,
        target.id,
        this.now().toISOString(),
      );
      return this.repo.get(target.id);
    }
    throw new ConflictError('Qdrant alias no longer matches the pending rollback');
  }

  private requireQdrantConfigured(): void {
    if (!this.configured) {
      throw new ConflictError('Qdrant is not configured');
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.repo.nextPending()) await this.processNext();
    } finally {
      this.draining = false;
    }
  }
}

class IndexJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IndexJobError';
  }
}

function safeIndexErrorCode(error: unknown): string {
  if (error instanceof IndexJobError) return error.code;
  if (error instanceof QdrantRequestError) return error.code;
  if (error instanceof ValidationError) return 'invalid_knowledge_snapshot';
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('timeout') || name.includes('abort')) return 'qdrant_timeout';
  return 'qdrant_request_failed';
}

type OfficialQdrantClient = InstanceType<typeof QdrantClient>;

function createQdrantClient(): OfficialQdrantClient {
  return new QdrantClient({
    url: config.vectorStore.qdrantUrl,
    apiKey: config.vectorStore.qdrantApiKey || undefined,
    timeout: config.vectorStore.timeoutMs,
    checkCompatibility: false,
  });
}

function createQdrantCollectionControl(): QdrantCollectionControl {
  const client = createQdrantClient();
  const withTrace = async <T>(
    traceId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await withHeaders({ 'x-request-id': traceId ?? uuidv4() }, work);
    } catch (error) {
      if (error instanceof QdrantRequestError || error instanceof ConflictError) throw error;
      throw new QdrantRequestError(safeIndexErrorCode(error) === 'qdrant_timeout'
        ? 'qdrant_timeout'
        : 'qdrant_request_failed');
    }
  };
  return {
    createCollection: (name, dimensions, traceId) => withTrace(
      traceId,
      () => client.createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
      }),
    ),
    async collectionInfo(name, traceId) {
      return withTrace(traceId, async () => {
        try {
          const collection = await client.getCollection(name);
          const vectors = collection.config.params.vectors;
          const dimensions = (
            vectors
            && typeof vectors === 'object'
            && 'size' in vectors
            && typeof vectors.size === 'number'
          ) ? vectors.size : 0;
          return {
            dimensions,
            count: collection.points_count ?? collection.indexed_vectors_count ?? 0,
          };
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 404) return null;
          throw error;
        }
      });
    },
    async currentAliasCollection(traceId) {
      const response = await withTrace(traceId, () => client.getAliases());
      return response.aliases.find(
        (alias) => alias.alias_name === config.vectorStore.collectionAlias,
      )?.collection_name ?? null;
    },
    async switchAlias(nextCollection, expectedCurrent, traceId) {
      const current = await this.currentAliasCollection(traceId);
      if (current !== expectedCurrent) {
        throw new ConflictError('Qdrant alias changed; refresh before activating');
      }
      const actions = current
        ? [
            { delete_alias: { alias_name: config.vectorStore.collectionAlias } },
            {
              create_alias: {
                alias_name: config.vectorStore.collectionAlias,
                collection_name: nextCollection,
              },
            },
          ]
        : [{
            create_alias: {
              alias_name: config.vectorStore.collectionAlias,
              collection_name: nextCollection,
            },
          }];
      await withTrace(traceId, () => client.updateCollectionAliases({ actions }));
    },
  };
}

function unavailableQdrantControl(): QdrantCollectionControl {
  const unavailable = async (): Promise<never> => {
    throw new ConflictError('Qdrant is not configured');
  };
  return {
    createCollection: unavailable,
    collectionInfo: unavailable,
    currentAliasCollection: unavailable,
    switchAlias: unavailable,
  };
}

let singleton: RetrievalIndexJobService | null = null;

export function getRetrievalIndexJobService(): RetrievalIndexJobService {
  if (!singleton) {
    const { getDatabase } = require('../db') as typeof import('../db');
    singleton = new RetrievalIndexJobService(getDatabase());
  }
  return singleton;
}
