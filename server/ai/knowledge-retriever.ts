import { KnowledgeType, RetrievalResult } from '../types/ai';
import { logger } from '../utils/logger';
import { VectorStore } from './vector-store';

export interface KnowledgeIndexItem {
  id: string;
  result: RetrievalResult;
  embedding: number[];
}

export interface KnowledgeAdapter {
  readonly knowledgeType: KnowledgeType;
  loadIndexItems(): Promise<KnowledgeIndexItem[]>;
  searchKeyword(query: string, limit: number): RetrievalResult[] | Promise<RetrievalResult[]>;
}

const SOURCE_PRIORITY: Record<NonNullable<RetrievalResult['source']>, number> = {
  hybrid: 3,
  vector: 2,
  keyword: 1,
};

export class KnowledgeRetriever {
  private initialized = false;
  private readonly indexedIds = new Map<KnowledgeType, Set<string>>();

  constructor(
    private readonly vectorStore: VectorStore<KnowledgeIndexItem>,
    private readonly embedTexts: (texts: string[]) => Promise<number[][]>,
    private readonly adapters: KnowledgeAdapter[],
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const adapter of this.adapters) {
      try {
        await this.refreshSource(adapter.knowledgeType);
      } catch (error) {
        logger.warn({
          knowledgeType: adapter.knowledgeType,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge vector source initialization failed');
      }
    }
    this.initialized = true;
  }

  async refreshSource(knowledgeType: KnowledgeType): Promise<void> {
    const adapter = this.adapters.find((candidate) => candidate.knowledgeType === knowledgeType);
    if (!adapter) return;
    const items = await adapter.loadIndexItems();
    const ids = new Set<string>();
    for (const item of items) {
      if (!item.id.startsWith(`${knowledgeType}:`)) {
        throw new Error(`Knowledge index id must use the ${knowledgeType}: namespace`);
      }
      ids.add(item.id);
    }
    for (const id of this.indexedIds.get(knowledgeType) ?? []) this.vectorStore.delete(id);
    for (const item of items) this.vectorStore.upsert(item, item.embedding);
    this.indexedIds.set(knowledgeType, ids);
  }

  async search(
    query: string,
    topK: number = 5,
    knowledgeTypes: KnowledgeType[] = ['faq', 'document'],
  ): Promise<RetrievalResult[]> {
    await this.initialize();
    const allowed = new Set(knowledgeTypes);
    const merged = new Map<string, RetrievalResult>();

    if (this.vectorStore.stats().indexedCount > 0) {
      try {
        const embeddings = await this.embedTexts([query]);
        const queryEmbedding = embeddings[0];
        if (queryEmbedding) {
          const candidateLimit = this.vectorStore.stats().indexedCount;
          for (const match of this.vectorStore.search(queryEmbedding, candidateLimit)) {
            if (!allowed.has(match.entry.result.knowledgeType)) continue;
            const vectorScore = match.score;
            merged.set(this.resultKey(match.entry.result), {
              ...match.entry.result,
              similarity: vectorScore,
              source: 'vector',
              vectorScore,
            });
          }
        }
      } catch {
        // Keyword retrieval remains available when query embedding fails.
      }
    }

    for (const adapter of this.adapters) {
      if (!allowed.has(adapter.knowledgeType)) continue;
      let keywordResults: RetrievalResult[];
      try {
        keywordResults = await adapter.searchKeyword(query, topK);
      } catch (error) {
        logger.warn({
          knowledgeType: adapter.knowledgeType,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge keyword source search failed');
        continue;
      }
      for (const result of keywordResults) {
        const key = this.resultKey(result);
        const existing = merged.get(key);
        const keywordScore = result.keywordScore ?? result.similarity;
        if (existing) {
          merged.set(key, {
            ...existing,
            source: 'hybrid',
            keywordScore,
            similarity: Math.max(existing.vectorScore ?? existing.similarity, keywordScore),
          });
        } else {
          merged.set(key, { ...result, source: 'keyword', keywordScore, similarity: keywordScore });
        }
      }
    }

    return [...merged.values()]
      .sort((a, b) => this.compare(a, b))
      .slice(0, topK);
  }

  stats(): ReturnType<VectorStore<KnowledgeIndexItem>['stats']> {
    return this.vectorStore.stats();
  }

  getIndexedCount(knowledgeType: KnowledgeType): number {
    return this.indexedIds.get(knowledgeType)?.size ?? 0;
  }

  upsertIndexItem(item: KnowledgeIndexItem): void {
    this.vectorStore.upsert(item, item.embedding);
    const ids = this.indexedIds.get(item.result.knowledgeType) ?? new Set<string>();
    ids.add(item.id);
    this.indexedIds.set(item.result.knowledgeType, ids);
  }

  deleteIndexItem(knowledgeType: KnowledgeType, namespacedId: string): void {
    this.vectorStore.delete(namespacedId);
    this.indexedIds.get(knowledgeType)?.delete(namespacedId);
  }

  private resultKey(result: RetrievalResult): string {
    return `${result.knowledgeType}:${result.knowledgeId}`;
  }

  private compare(a: RetrievalResult, b: RetrievalResult): number {
    const scoreDelta = b.similarity - a.similarity;
    if (scoreDelta !== 0) return scoreDelta;
    return SOURCE_PRIORITY[b.source ?? 'keyword'] - SOURCE_PRIORITY[a.source ?? 'keyword'];
  }
}
