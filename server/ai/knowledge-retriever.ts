import { v4 as uuidv4 } from 'uuid';
import { KnowledgeType, RetrievalResult } from '../types/ai';
import { logger } from '../utils/logger';
import { VectorStore } from './vector-store';
import { expandRetrievalQuery } from './query-expansion';
import { rankRetrievalResults } from './retrieval-ranking';
import type { RetrievalPolicyConfig } from '../types/quality';

export interface KnowledgeIndexItem {
  id: string;
  result: RetrievalResult;
  embedding: number[];
}

export interface KnowledgeIndexLoad {
  items: KnowledgeIndexItem[];
  rollbackPersisted?: () => void;
}

export interface KnowledgeAdapter {
  readonly knowledgeType: KnowledgeType;
  getEmbeddingProfile?(): string;
  loadIndexItems(): Promise<KnowledgeIndexItem[] | KnowledgeIndexLoad>;
  searchKeyword(query: string, limit: number): RetrievalResult[] | Promise<RetrievalResult[]>;
}

const MIN_CANDIDATE_POOL = 20;
const MAX_CANDIDATE_POOL = 100;
const CANDIDATE_MULTIPLIER = 4;
const RRF_RANK_CONSTANT = 60;
const VECTOR_RRF_WEIGHT = 1;
const KEYWORD_RRF_WEIGHT = 4;

export class KnowledgeRetriever {
  private initialized = false;
  private readonly indexedIds = new Map<KnowledgeType, Set<string>>();
  private readonly indexedItems = new Map<KnowledgeType, Map<string, KnowledgeIndexItem>>();
  private readonly indexedProfiles = new Map<KnowledgeType, string>();
  private readonly failedSources = new Set<KnowledgeType>();
  private readonly retryAfter = new Map<KnowledgeType, number>();
  private initializationPromise: Promise<void> | null = null;
  private readonly refreshPromises = new Map<KnowledgeType, Promise<void>>();

  constructor(
    private readonly vectorStore: VectorStore<KnowledgeIndexItem>,
    private readonly embedTexts: (texts: string[]) => Promise<number[][]>,
    private readonly adapters: KnowledgeAdapter[],
  ) {}

  async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    const promise = this.initializePendingSources();
    this.initializationPromise = promise;
    try {
      await promise;
    } finally {
      if (this.initializationPromise === promise) this.initializationPromise = null;
    }
  }

  private async initializePendingSources(): Promise<void> {
    const operationId = uuidv4();
    const now = Date.now();
    const pendingAdapters = this.initialized
      ? this.adapters.filter((adapter) => {
          if (this.failedSources.has(adapter.knowledgeType)) {
            return (this.retryAfter.get(adapter.knowledgeType) ?? 0) <= now;
          }

          return (
            adapter.getEmbeddingProfile !== undefined
            && adapter.getEmbeddingProfile() !== this.indexedProfiles.get(adapter.knowledgeType)
          );
        })
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
    const pending = this.refreshPromises.get(knowledgeType);
    if (pending) return pending;
    const promise = this.applySourceRefresh(knowledgeType, operationId);
    this.refreshPromises.set(knowledgeType, promise);
    try {
      await promise;
    } finally {
      if (this.refreshPromises.get(knowledgeType) === promise) {
        this.refreshPromises.delete(knowledgeType);
      }
    }
  }

  private async applySourceRefresh(
    knowledgeType: KnowledgeType,
    operationId: string,
  ): Promise<void> {
    const adapter = this.adapters.find((candidate) => candidate.knowledgeType === knowledgeType);
    if (!adapter) return;
    const previousItems = this.indexedItems.get(knowledgeType) ?? new Map<string, KnowledgeIndexItem>();
    try {
      const loaded = await adapter.loadIndexItems();
      const items = Array.isArray(loaded) ? loaded : loaded.items;
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
        if (!Array.isArray(loaded) && loaded.rollbackPersisted) {
          try {
            loaded.rollbackPersisted();
          } catch (rollbackError) {
            logger.error({
              operationId,
              knowledgeType,
              errorName: rollbackError instanceof Error ? rollbackError.name : 'UnknownError',
            }, 'Knowledge persisted-vector rollback failed');
          }
        }
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
      if (adapter.getEmbeddingProfile) {
        this.indexedProfiles.set(knowledgeType, adapter.getEmbeddingProfile());
      }
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
    policy?: RetrievalPolicyConfig,
  ): Promise<RetrievalResult[]> {
    await this.initialize();
    const expandedQuery = expandRetrievalQuery(query);
    const candidateLimit = Math.min(
      MAX_CANDIDATE_POOL,
      Math.max(MIN_CANDIDATE_POOL, topK * CANDIDATE_MULTIPLIER),
    );
    const queryEmbedding = await this.embedQueries([expandedQuery]);
    const candidates = await this.retrieveCandidates(
      query,
      expandedQuery,
      queryEmbedding[0],
      candidateLimit,
      knowledgeTypes,
    );

    return rankRetrievalResults({
      query,
      candidates,
      topK,
      knowledgeTypes,
      policy,
    });
  }

  async searchCandidatesBatch(
    queries: string[],
    limit: number = MAX_CANDIDATE_POOL,
    knowledgeTypes: KnowledgeType[] = ['faq', 'document'],
  ): Promise<RetrievalResult[][]> {
    if (queries.length === 0) return [];
    await this.initialize();
    const expanded = queries.map(expandRetrievalQuery);
    const embeddings = await this.embedQueries(expanded);
    const candidateLimit = Math.min(MAX_CANDIDATE_POOL, Math.max(1, limit));
    return Promise.all(queries.map((query, index) => this.retrieveCandidates(
      query,
      expanded[index],
      embeddings[index],
      candidateLimit,
      knowledgeTypes,
    )));
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

  replaceDocumentIndexItems(documentId: string, nextItems: KnowledgeIndexItem[]): void {
    const knowledgeType: KnowledgeType = 'document';
    const currentItems = this.indexedItems.get(knowledgeType) ?? new Map<string, KnowledgeIndexItem>();
    const previousDocumentItems = [...currentItems.values()].filter(
      (item) => item.result.documentId === documentId,
    );
    if (nextItems.some((item) => (
      !item.id.startsWith('document:') || item.result.documentId !== documentId
    ))) {
      throw new Error('Replacement document index items must use the target document namespace');
    }
    try {
      for (const item of previousDocumentItems) this.vectorStore.delete(item.id);
      for (const item of nextItems) this.vectorStore.upsert(item, item.embedding);
    } catch (error) {
      try {
        for (const item of nextItems) this.vectorStore.delete(item.id);
        for (const item of previousDocumentItems) {
          this.vectorStore.upsert(item, item.embedding);
        }
      } catch (rollbackError) {
        logger.error({
          documentId,
          errorName: rollbackError instanceof Error ? rollbackError.name : 'UnknownError',
        }, 'Document index replacement rollback failed');
      }
      throw error;
    }
    const replaced = new Map(currentItems);
    for (const item of previousDocumentItems) replaced.delete(item.id);
    for (const item of nextItems) replaced.set(item.id, item);
    this.indexedItems.set(knowledgeType, replaced);
    this.indexedIds.set(knowledgeType, new Set(replaced.keys()));
  }

  deleteIndexItem(knowledgeType: KnowledgeType, namespacedId: string): void {
    this.vectorStore.delete(namespacedId);
    this.indexedItems.get(knowledgeType)?.delete(namespacedId);
    this.indexedIds.get(knowledgeType)?.delete(namespacedId);
  }

  private resultKey(result: RetrievalResult): string {
    return `${result.knowledgeType}:${result.knowledgeId}`;
  }

  private rrfScore(rank: number, weight: number): number {
    return weight / (RRF_RANK_CONSTANT + rank);
  }

  private async embedQueries(queries: string[]): Promise<Array<number[] | undefined>> {
    if (this.vectorStore.stats().indexedCount === 0) return queries.map(() => undefined);
    try {
      return await this.embedTexts(queries);
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        queryCount: queries.length,
      }, 'Knowledge vector query batch failed; using keyword fallback');
      return queries.map(() => undefined);
    }
  }

  private async retrieveCandidates(
    query: string,
    expandedQuery: string,
    queryEmbedding: number[] | undefined,
    candidateLimit: number,
    knowledgeTypes: KnowledgeType[],
  ): Promise<RetrievalResult[]> {
    const operationId = uuidv4();
    const allowed = new Set(knowledgeTypes);
    const merged = new Map<string, RetrievalResult>();
    if (queryEmbedding) {
      const vectorCandidates = [...allowed].flatMap((knowledgeType) => (
        this.vectorStore.search(
          queryEmbedding,
          candidateLimit,
          (entry) => entry.result.knowledgeType === knowledgeType,
        )
      )).sort((left, right) => right.score - left.score);
      for (const [index, match] of vectorCandidates.entries()) {
        const vectorScore = match.score;
        const vectorRank = index + 1;
        merged.set(this.resultKey(match.entry.result), {
          ...match.entry.result,
          similarity: vectorScore,
          source: 'vector',
          vectorScore,
          vectorRank,
          fusionScore: this.rrfScore(vectorRank, VECTOR_RRF_WEIGHT),
        });
      }
    }
    const keywordLists = await Promise.all(this.adapters
      .filter((adapter) => allowed.has(adapter.knowledgeType))
      .map(async (adapter) => {
        try {
          return await adapter.searchKeyword(
            adapter.knowledgeType === 'document' ? expandedQuery : query,
            candidateLimit,
          );
        } catch (error) {
          logger.warn({
            operationId,
            knowledgeType: adapter.knowledgeType,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }, 'Knowledge keyword source search failed');
          return [];
        }
      }));
    for (const keywordResults of keywordLists) {
      for (const [index, result] of keywordResults.entries()) {
        const key = this.resultKey(result);
        const existing = merged.get(key);
        const keywordScore = result.keywordScore ?? result.similarity;
        const keywordRank = index + 1;
        const keywordFusionScore = this.rrfScore(keywordRank, KEYWORD_RRF_WEIGHT);
        merged.set(key, existing ? {
          ...existing,
          source: 'hybrid',
          keywordScore,
          keywordRank,
          fusionScore: (existing.fusionScore ?? 0) + keywordFusionScore,
          similarity: Math.max(existing.vectorScore ?? existing.similarity, keywordScore),
        } : {
          ...result,
          source: 'keyword',
          keywordScore,
          keywordRank,
          fusionScore: keywordFusionScore,
          similarity: keywordScore,
        });
      }
    }
    return [...merged.values()];
  }

}
