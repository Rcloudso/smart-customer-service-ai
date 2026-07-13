import { v4 as uuidv4 } from 'uuid';
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
  private readonly indexedItems = new Map<KnowledgeType, Map<string, KnowledgeIndexItem>>();
  private readonly failedSources = new Set<KnowledgeType>();
  private readonly retryAfter = new Map<KnowledgeType, number>();

  constructor(
    private readonly vectorStore: VectorStore<KnowledgeIndexItem>,
    private readonly embedTexts: (texts: string[]) => Promise<number[][]>,
    private readonly adapters: KnowledgeAdapter[],
  ) {}

  async initialize(): Promise<void> {
    const operationId = uuidv4();
    const now = Date.now();
    const pendingAdapters = this.initialized
      ? this.adapters.filter((adapter) => (
          this.failedSources.has(adapter.knowledgeType)
          && (this.retryAfter.get(adapter.knowledgeType) ?? 0) <= now
        ))
      : this.adapters;
    if (this.initialized && pendingAdapters.length === 0) return;
    for (const adapter of pendingAdapters) {
      try {
        await this.refreshSource(adapter.knowledgeType, operationId);
        this.failedSources.delete(adapter.knowledgeType);
        this.retryAfter.delete(adapter.knowledgeType);
      } catch (error) {
        this.failedSources.add(adapter.knowledgeType);
        this.retryAfter.set(adapter.knowledgeType, now + 30_000);
        logger.warn({
          operationId,
          knowledgeType: adapter.knowledgeType,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge vector source initialization failed');
      }
    }
    this.initialized = true;
  }

  async refreshSource(knowledgeType: KnowledgeType, operationId: string = uuidv4()): Promise<void> {
    const adapter = this.adapters.find((candidate) => candidate.knowledgeType === knowledgeType);
    if (!adapter) return;
    const previousItems = this.indexedItems.get(knowledgeType) ?? new Map<string, KnowledgeIndexItem>();
    try {
      const items = await adapter.loadIndexItems();
      const nextItems = new Map<string, KnowledgeIndexItem>();
      for (const item of items) {
        if (!item.id.startsWith(`${knowledgeType}:`)) {
          throw new Error(`Knowledge index id must use the ${knowledgeType}: namespace`);
        }
        nextItems.set(item.id, item);
      }
      try {
        for (const id of previousItems.keys()) this.vectorStore.delete(id);
        for (const item of nextItems.values()) this.vectorStore.upsert(item, item.embedding);
      } catch (applyError) {
        try {
          for (const id of nextItems.keys()) this.vectorStore.delete(id);
          for (const item of previousItems.values()) this.vectorStore.upsert(item, item.embedding);
        } catch (rollbackError) {
          logger.error({
            operationId,
            knowledgeType,
            errorName: rollbackError instanceof Error ? rollbackError.name : 'UnknownError',
          }, 'Knowledge vector source rollback failed');
        }
        throw applyError;
      }
      this.indexedItems.set(knowledgeType, nextItems);
      this.indexedIds.set(knowledgeType, new Set(nextItems.keys()));
      this.failedSources.delete(knowledgeType);
      this.retryAfter.delete(knowledgeType);
    } catch (error) {
      this.failedSources.add(knowledgeType);
      this.retryAfter.set(knowledgeType, Date.now() + 30_000);
      logger.warn({
        operationId,
        knowledgeType,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Knowledge vector source refresh failed');
      throw error;
    }
  }

  async search(
    query: string,
    topK: number = 5,
    knowledgeTypes: KnowledgeType[] = ['faq', 'document'],
  ): Promise<RetrievalResult[]> {
    await this.initialize();
    const operationId = uuidv4();
    const allowed = new Set(knowledgeTypes);
    const merged = new Map<string, RetrievalResult>();

    if (this.vectorStore.stats().indexedCount > 0) {
      try {
        const embeddings = await this.embedTexts([query]);
        const queryEmbedding = embeddings[0];
        if (queryEmbedding) {
          for (const match of this.vectorStore.search(
            queryEmbedding,
            topK,
            (entry) => allowed.has(entry.result.knowledgeType),
          )) {
            const vectorScore = match.score;
            merged.set(this.resultKey(match.entry.result), {
              ...match.entry.result,
              similarity: vectorScore,
              source: 'vector',
              vectorScore,
            });
          }
        }
      } catch (error) {
        logger.warn({
          operationId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge vector query failed; using keyword fallback');
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
          operationId,
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

  getFailedSources(): KnowledgeType[] {
    return [...this.failedSources];
  }

  hasInitialized(): boolean {
    return this.initialized;
  }

  upsertIndexItem(item: KnowledgeIndexItem): void {
    this.vectorStore.upsert(item, item.embedding);
    const items = this.indexedItems.get(item.result.knowledgeType) ?? new Map<string, KnowledgeIndexItem>();
    items.set(item.id, item);
    this.indexedItems.set(item.result.knowledgeType, items);
    const ids = this.indexedIds.get(item.result.knowledgeType) ?? new Set<string>();
    ids.add(item.id);
    this.indexedIds.set(item.result.knowledgeType, ids);
  }

  deleteIndexItem(knowledgeType: KnowledgeType, namespacedId: string): void {
    this.vectorStore.delete(namespacedId);
    this.indexedItems.get(knowledgeType)?.delete(namespacedId);
    this.indexedIds.get(knowledgeType)?.delete(namespacedId);
  }

  private resultKey(result: RetrievalResult): string {
    return `${result.knowledgeType}:${result.knowledgeId}`;
  }

  private compare(a: RetrievalResult, b: RetrievalResult): number {
    const directFaqDelta = Number(this.isDirectFaqCandidate(b)) - Number(this.isDirectFaqCandidate(a));
    if (directFaqDelta !== 0) return directFaqDelta;
    const scoreDelta = b.similarity - a.similarity;
    if (scoreDelta !== 0) return scoreDelta;
    return SOURCE_PRIORITY[b.source ?? 'keyword'] - SOURCE_PRIORITY[a.source ?? 'keyword'];
  }

  private isDirectFaqCandidate(result: RetrievalResult): boolean {
    return result.knowledgeType === 'faq'
      && (result.source === 'keyword' || result.source === 'hybrid')
      && (result.keywordScore ?? result.similarity) >= 0.65;
  }
}
