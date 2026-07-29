import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { QdrantClient, withHeaders } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { RetrievalIndexJobRepo } from '../db/repos/retrieval-index-job.repo';
import type { VectorRecord } from '../ai/vector-store';
import { QdrantVectorStore } from '../ai/qdrant-vector-store';
import type {
  RetrievalActivationCheck,
  RetrievalIndexJob,
} from '../types/retrieval-ops';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { knowledgeFingerprint } from './knowledge-fingerprint';

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
    if (this.autoDrain) queueMicrotask(() => void this.drain());
  }

  async createJob(params: { createdBy: string }): Promise<RetrievalIndexJob> {
    this.requireQdrantConfigured();
    const snapshot = this.readSnapshot();
    const reusable = this.repo.findReusable(snapshot.fingerprint, snapshot.embeddingProfile);
    if (reusable) return reusable;
    const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
    const timestamp = this.now().toISOString().replace(/\D/g, '').slice(0, 14);
    const job = this.repo.create({
      collection: `${this.collectionPrefix}_${timestamp}_${suffix}`,
      embeddingProfile: snapshot.embeddingProfile,
      vectorDimension: snapshot.vectorDimension,
      knowledgeFingerprint: snapshot.fingerprint,
      expectedCount: snapshot.records.length,
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
    const snapshot = this.readSnapshot();
    if (
      snapshot.fingerprint !== pending.knowledgeFingerprint
      || snapshot.embeddingProfile !== pending.embeddingProfile
      || snapshot.vectorDimension !== pending.vectorDimension
      || snapshot.records.length !== pending.expectedCount
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
      for (
        let offset = pending.checkpoint;
        offset < snapshot.records.length;
        offset += INDEX_BATCH_SIZE
      ) {
        const batch = snapshot.records.slice(offset, offset + INDEX_BATCH_SIZE);
        await writer.upsert(batch, traceId);
        const checkpoint = offset + batch.length;
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
    const quality = this.db.prepare(`
      SELECT candidate.run_id, candidate.candidate_key
      FROM quality_run_candidates candidate
      JOIN quality_runs run ON run.id = candidate.run_id
      WHERE run.status = 'completed'
        AND json_extract(candidate.backend_target, '$.provider') = 'qdrant'
        AND json_extract(candidate.backend_target, '$.indexJobId') = ?
      ORDER BY run.completed_at DESC
      LIMIT 1
    `).get(id) as { run_id: string; candidate_key: string } | undefined;
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
    const { QualityLabService } = require('./quality-lab.service') as typeof import(
      './quality-lab.service'
    );
    const { QualityRunService } = require('./quality-run.service') as typeof import(
      './quality-run.service'
    );
    const qualityLab = new QualityLabService(this.db);
    const gate = new QualityRunService(this.db, {
      qualityLab,
      autoDrain: false,
      getIndexJob: (jobId) => this.getJob(jobId),
    }).checkBackendActivation(quality.run_id, quality.candidate_key);
    reasons.push(...gate.reasons);
    warnings.push(...gate.warnings);
    return {
      eligible: reasons.length === 0,
      warnings: [...new Set(warnings)],
      reasons: [...new Set(reasons)],
      qualityRunId: quality.run_id,
      candidateKey: quality.candidate_key,
    };
  }

  async activate(params: {
    id: string;
    expectedCurrentCollection: string | null;
    confirmLatencyWarning: boolean;
  }): Promise<RetrievalIndexJob> {
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
    await this.control.switchAlias(job.collection, current, uuidv4());
    this.repo.activate(job.id, current, this.now().toISOString());
    return this.getJob(job.id);
  }

  async rollback(params: {
    id: string;
    expectedCurrentCollection: string;
  }): Promise<RetrievalIndexJob> {
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
    await this.control.switchAlias(target.collection, job.collection, uuidv4());
    this.repo.activateRollbackTarget(target.id, this.now().toISOString());
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

  private readSnapshot(): {
    fingerprint: string;
    embeddingProfile: string;
    vectorDimension: number;
    records: VectorRecord[];
  } {
    const rows = this.db.prepare(`
      SELECT 'faq' AS knowledge_type, id, updated_at AS revision,
             embedding_profile, embedding
      FROM faq_entries
      WHERE is_active = 1 AND embedding IS NOT NULL
      UNION ALL
      SELECT 'document' AS knowledge_type, chunk.id, chunk.created_at AS revision,
             chunk.embedding_profile, chunk.embedding
      FROM document_chunks chunk
      JOIN documents document ON document.id = chunk.document_id
      WHERE document.is_active = 1
        AND document.status = 'ready'
        AND document.index_status IN ('legacy', 'published')
      ORDER BY knowledge_type, id
    `).all() as Array<{
      knowledge_type: 'faq' | 'document';
      id: string;
      revision: string;
      embedding_profile: string | null;
      embedding: string;
    }>;
    if (rows.length === 0) throw new ValidationError('No active embedded knowledge to index');
    const records = rows.map((row): VectorRecord => {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding) as number[];
      } catch {
        throw new ValidationError('Knowledge embedding is malformed');
      }
      if (
        embedding.length === 0
        || embedding.some((value) => !Number.isFinite(value))
        || !row.embedding_profile
      ) {
        throw new ValidationError('All active knowledge must have a valid embedding profile');
      }
      return {
        id: `${row.knowledge_type}:${row.id}`,
        knowledgeType: row.knowledge_type,
        revision: row.revision,
        embeddingProfile: row.embedding_profile,
        embedding,
      };
    });
    const dimensions = new Set(records.map((record) => record.embedding.length));
    if (dimensions.size !== 1) {
      throw new ValidationError('Active knowledge embeddings must use one vector dimension');
    }
    const profiles = [...new Set(records.map((record) => record.embeddingProfile))].sort();
    const profileHash = createHash('sha256')
      .update(JSON.stringify(profiles))
      .digest('hex')
      .slice(0, 16);
    return {
      fingerprint: knowledgeFingerprint(this.db),
      embeddingProfile: `combined:${profileHash}`,
      vectorDimension: records[0].embedding.length,
      records,
    };
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
    checkCompatibility: true,
  });
}

function createQdrantCollectionControl(): QdrantCollectionControl {
  const client = createQdrantClient();
  const withTrace = async <T>(traceId: string | undefined, work: () => Promise<T>): Promise<T> => (
    traceId ? withHeaders({ 'x-request-id': traceId }, work) : work()
  );
  return {
    createCollection: (name, dimensions, traceId) => withTrace(
      traceId,
      () => client.createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
      }),
    ),
    async collectionInfo(name, traceId) {
      try {
        const collection = await withTrace(traceId, () => client.getCollection(name));
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
