import { FaqEntry } from '../types/domain';

export interface VectorStoreItem<T extends { id: string } = FaqEntry> {
  id: string;
  entry: T;
  embedding: number[];
}

export interface VectorSearchResult<T extends { id: string } = FaqEntry> extends VectorStoreItem<T> {
  score: number;
}

export interface VectorStoreStats {
  indexedCount: number;
  embeddingDimensions: number | null;
  updatedAt: string | null;
}

export interface VectorStore<T extends { id: string } = FaqEntry> {
  upsert(entry: T, embedding: number[]): void;
  delete(id: string): void;
  search(
    queryEmbedding: number[],
    limit: number,
    predicate?: (entry: T) => boolean,
  ): VectorSearchResult<T>[];
  stats(): VectorStoreStats;
  clear(): void;
}

export class InMemoryVectorStore<T extends { id: string } = FaqEntry> implements VectorStore<T> {
  private items = new Map<string, VectorStoreItem<T>>();
  private updatedAt: string | null = null;

  upsert(entry: T, embedding: number[]): void {
    if (embedding.length === 0) {
      this.delete(entry.id);
      return;
    }
    this.items.set(entry.id, { id: entry.id, entry, embedding });
    this.updatedAt = new Date().toISOString();
  }

  delete(id: string): void {
    if (this.items.delete(id)) this.updatedAt = new Date().toISOString();
  }

  search(
    queryEmbedding: number[],
    limit: number,
    predicate: (entry: T) => boolean = () => true,
  ): VectorSearchResult<T>[] {
    if (queryEmbedding.length === 0 || limit <= 0) return [];
    const best: VectorSearchResult<T>[] = [];
    for (const item of this.items.values()) {
      if (!predicate(item.entry)) continue;
      const result = { ...item, score: cosineSimilarity(queryEmbedding, item.embedding) };
      const insertAt = best.findIndex((candidate) => result.score > candidate.score);
      if (insertAt < 0) best.push(result);
      else best.splice(insertAt, 0, result);
      if (best.length > limit) best.pop();
    }
    return best;
  }

  stats(): VectorStoreStats {
    const firstItem = this.items.values().next().value as VectorStoreItem<T> | undefined;
    return {
      indexedCount: this.items.size,
      embeddingDimensions: firstItem?.embedding.length ?? null,
      updatedAt: this.updatedAt,
    };
  }

  clear(): void {
    this.items.clear();
    this.updatedAt = new Date().toISOString();
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
