import { QdrantClient, withHeaders } from '@qdrant/js-client-rest';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import type { KnowledgeType } from '../types/ai';
import type {
  VectorRecord,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreHealth,
  VectorStoreStats,
} from './vector-store';

const POINT_ID_NAMESPACE = uuidv5('resolveweave-vector-points', uuidv5.URL);

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

interface QdrantCollectionInfo {
  status?: string;
  points_count?: number | null;
  indexed_vectors_count?: number | null;
  config?: {
    params?: {
      vectors?: unknown;
    };
  };
}

export interface QdrantClientLike {
  upsert(collection: string, payload: Record<string, unknown>): Promise<unknown>;
  delete(collection: string, payload: Record<string, unknown>): Promise<unknown>;
  query(collection: string, payload: Record<string, unknown>): Promise<{
    points?: QdrantPoint[];
  }>;
  getCollection(collection: string): Promise<QdrantCollectionInfo>;
}

export type QdrantHeaderRunner = <T>(
  headers: Record<string, string>,
  operation: () => Promise<T>,
) => Promise<T>;

export interface QdrantVectorStoreOptions {
  client: QdrantClientLike;
  collectionAlias: string;
  runWithHeaders?: QdrantHeaderRunner;
}

export class QdrantRequestError extends Error {
  constructor(readonly code: 'qdrant_timeout' | 'qdrant_request_failed') {
    super(code === 'qdrant_timeout' ? 'Qdrant request timed out' : 'Qdrant request failed');
    this.name = 'QdrantRequestError';
  }
}

export class QdrantVectorStore implements VectorStore {
  readonly backend = 'qdrant';
  readonly supportsStartupSync = false;
  private readonly client: QdrantClientLike;
  private readonly collectionAlias: string;
  private readonly runWithHeaders: QdrantHeaderRunner;
  private updatedAt: string | null = null;

  constructor(options: QdrantVectorStoreOptions) {
    this.client = options.client;
    this.collectionAlias = options.collectionAlias;
    this.runWithHeaders = options.runWithHeaders ?? (async (headers, operation) => (
      withHeaders(headers, operation)
    ));
  }

  async upsertBatch(records: VectorRecord[], traceId?: string): Promise<void> {
    if (records.length === 0) return;
    await this.withTrace(traceId, () => this.client.upsert(this.collectionAlias, {
      wait: true,
      ordering: 'medium',
      points: records.map((record) => ({
        id: pointId(record.id),
        vector: record.embedding,
        payload: {
          pointKey: record.id,
          knowledgeType: record.knowledgeType,
          revision: record.revision,
          embeddingProfile: record.embeddingProfile,
        },
      })),
    }));
    this.updatedAt = new Date().toISOString();
  }

  async delete(ids: string[], traceId?: string): Promise<void> {
    if (ids.length === 0) return;
    await this.withTrace(traceId, () => this.client.delete(this.collectionAlias, {
      wait: true,
      ordering: 'medium',
      points: ids.map(pointId),
    }));
    this.updatedAt = new Date().toISOString();
  }

  async search(
    queryEmbedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    if (queryEmbedding.length === 0 || options.limit <= 0) return [];
    const response = await this.withTrace(options.traceId, () => (
      this.client.query(this.collectionAlias, {
        query: queryEmbedding,
        limit: options.limit,
        with_payload: ['pointKey', 'knowledgeType', 'revision', 'embeddingProfile'],
        with_vector: false,
        filter: options.knowledgeTypes?.length
          ? {
              must: [{
                key: 'knowledgeType',
                match: { any: options.knowledgeTypes },
              }],
            }
          : undefined,
      })
    ));
    return (response.points ?? []).flatMap((point) => {
      const payload = point.payload;
      const knowledgeType = payload?.knowledgeType;
      if (
        typeof payload?.pointKey !== 'string'
        || (knowledgeType !== 'faq' && knowledgeType !== 'document')
        || typeof payload.revision !== 'string'
        || typeof payload.embeddingProfile !== 'string'
        || typeof point.score !== 'number'
        || !Number.isFinite(point.score)
      ) return [];
      return [{
        id: payload.pointKey,
        knowledgeType: knowledgeType as KnowledgeType,
        revision: payload.revision,
        embeddingProfile: payload.embeddingProfile,
        score: point.score,
      }];
    });
  }

  async stats(traceId?: string): Promise<VectorStoreStats> {
    const collection = await this.withTrace(traceId, () => (
      this.client.getCollection(this.collectionAlias)
    ));
    return {
      indexedCount: collection.points_count ?? collection.indexed_vectors_count ?? 0,
      embeddingDimensions: vectorDimensions(collection.config?.params?.vectors),
      updatedAt: this.updatedAt,
    };
  }

  async health(traceId?: string): Promise<VectorStoreHealth> {
    try {
      const collection = await this.withTrace(traceId, () => (
        this.client.getCollection(this.collectionAlias)
      ));
      return {
        backend: 'qdrant',
        status: collection.status === 'red' ? 'degraded' : 'healthy',
        checkedAt: new Date().toISOString(),
        errorCode: collection.status === 'red' ? 'qdrant_collection_degraded' : null,
      };
    } catch {
      return {
        backend: 'qdrant',
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        errorCode: 'qdrant_unreachable',
      };
    }
  }

  private async withTrace<T>(traceId: string | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.runWithHeaders(
        { 'x-request-id': traceId ?? uuidv4() },
        operation,
      );
    } catch (error) {
      if (error instanceof QdrantRequestError) throw error;
      throw new QdrantRequestError(isTimeoutError(error)
        ? 'qdrant_timeout'
        : 'qdrant_request_failed');
    }
  }
}

export function createQdrantVectorStore(params: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  collectionAlias: string;
}): QdrantVectorStore {
  const client = new QdrantClient({
    url: params.url,
    apiKey: params.apiKey || undefined,
    timeout: params.timeoutMs,
    checkCompatibility: false,
  });
  return new QdrantVectorStore({
    client: client as QdrantClientLike,
    collectionAlias: params.collectionAlias,
  });
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const code = typeof error === 'object' && error
    ? String((error as { code?: unknown }).code ?? '').toLowerCase()
    : '';
  return name.includes('timeout')
    || name.includes('abort')
    || code.includes('timeout')
    || code === 'etimedout';
}

function pointId(key: string): string {
  return uuidv5(key, POINT_ID_NAMESPACE);
}

function vectorDimensions(vectors: unknown): number | null {
  if (!vectors || typeof vectors !== 'object') return null;
  const record = vectors as Record<string, unknown>;
  if (typeof record.size === 'number') return record.size;
  for (const candidate of Object.values(record)) {
    if (
      candidate
      && typeof candidate === 'object'
      && typeof (candidate as Record<string, unknown>).size === 'number'
    ) {
      return (candidate as Record<string, number>).size;
    }
  }
  return null;
}
