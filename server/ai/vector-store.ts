import { FaqEntry } from '../types/domain';

export interface VectorStoreItem {
  id: string;
  entry: FaqEntry;
  embedding: number[];
}

export interface VectorSearchResult extends VectorStoreItem {
  score: number;
}

export interface VectorStoreStats {
  indexedCount: number;
  embeddingDimensions: number | null;
  updatedAt: string | null;
}

export interface VectorStore {
  upsert(entry: FaqEntry, embedding: number[]): void;
  delete(id: string): void;
  search(queryEmbedding: number[], limit: number): VectorSearchResult[];
  stats(): VectorStoreStats;
  clear(): void;
}

export class InMemoryVectorStore implements VectorStore {
  private items = new Map<string, VectorStoreItem>();
  private updatedAt: string | null = null;

  upsert(entry: FaqEntry, embedding: number[]): void {
    if (embedding.length === 0) {
      this.delete(entry.id);
      return;
    }

    this.items.set(entry.id, { id: entry.id, entry, embedding });
    this.updatedAt = new Date().toISOString();
  }

  delete(id: string): void {
    if (this.items.delete(id)) {
      this.updatedAt = new Date().toISOString();
    }
  }

  search(queryEmbedding: number[], limit: number): VectorSearchResult[] {
    if (queryEmbedding.length === 0 || limit <= 0) {
      return [];
    }

    const scored: VectorSearchResult[] = [];
    for (const item of this.items.values()) {
      scored.push({
        ...item,
        score: this.cosineSimilarity(queryEmbedding, item.embedding),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  stats(): VectorStoreStats {
    const firstItem = this.items.values().next().value as VectorStoreItem | undefined;
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

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
