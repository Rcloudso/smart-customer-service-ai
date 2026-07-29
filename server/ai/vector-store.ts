import type { KnowledgeType } from '../types/ai';

export interface VectorRecord {
  id: string;
  knowledgeType: KnowledgeType;
  revision: string;
  embeddingProfile: string;
  embedding: number[];
}

export interface VectorSearchResult {
  id: string;
  knowledgeType: KnowledgeType;
  revision: string;
  embeddingProfile: string;
  score: number;
}

export interface VectorSearchOptions {
  limit: number;
  knowledgeTypes?: KnowledgeType[];
  traceId?: string;
}

export interface VectorStoreStats {
  indexedCount: number;
  embeddingDimensions: number | null;
  updatedAt: string | null;
}

export interface VectorStoreHealth {
  backend: 'memory' | 'qdrant';
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  errorCode: string | null;
}

export interface VectorStore {
  readonly supportsStartupSync: boolean;
  upsertBatch(records: VectorRecord[], traceId?: string): Promise<void>;
  delete(ids: string[], traceId?: string): Promise<void>;
  search(queryEmbedding: number[], options: VectorSearchOptions): Promise<VectorSearchResult[]>;
  stats(traceId?: string): Promise<VectorStoreStats>;
  health(traceId?: string): Promise<VectorStoreHealth>;
}

export class InMemoryVectorStore implements VectorStore {
  readonly supportsStartupSync = true;
  private items = new Map<string, VectorRecord>();
  private updatedAt: string | null = null;

  async upsertBatch(records: VectorRecord[], _traceId?: string): Promise<void> {
    for (const record of records) {
      if (record.embedding.length === 0) {
        this.items.delete(record.id);
        continue;
      }
      this.items.set(record.id, {
        ...record,
        embedding: [...record.embedding],
      });
    }
    if (records.length > 0) this.updatedAt = new Date().toISOString();
  }

  async delete(ids: string[], _traceId?: string): Promise<void> {
    let changed = false;
    for (const id of ids) changed = this.items.delete(id) || changed;
    if (changed) this.updatedAt = new Date().toISOString();
  }

  async search(
    queryEmbedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    if (queryEmbedding.length === 0 || options.limit <= 0) return [];
    const allowed = options.knowledgeTypes
      ? new Set<KnowledgeType>(options.knowledgeTypes)
      : null;
    const best: VectorSearchResult[] = [];
    for (const item of this.items.values()) {
      if (allowed && !allowed.has(item.knowledgeType)) continue;
      const result = {
        id: item.id,
        knowledgeType: item.knowledgeType,
        revision: item.revision,
        embeddingProfile: item.embeddingProfile,
        score: cosineSimilarity(queryEmbedding, item.embedding),
      };
      const insertAt = best.findIndex((candidate) => result.score > candidate.score);
      if (insertAt < 0) best.push(result);
      else best.splice(insertAt, 0, result);
      if (best.length > options.limit) best.pop();
    }
    return best;
  }

  async stats(_traceId?: string): Promise<VectorStoreStats> {
    const firstItem = this.items.values().next().value as VectorRecord | undefined;
    return {
      indexedCount: this.items.size,
      embeddingDimensions: firstItem?.embedding.length ?? null,
      updatedAt: this.updatedAt,
    };
  }

  async health(_traceId?: string): Promise<VectorStoreHealth> {
    return {
      backend: 'memory',
      status: 'healthy',
      checkedAt: new Date().toISOString(),
      errorCode: null,
    };
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dotProduct += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
