import { v4 as uuidv4 } from 'uuid';
import { KnowledgeType, RetrievalResult } from '../types/ai';
import { logger } from '../utils/logger';
import { VectorStore } from './vector-store';
import { expandRetrievalQuery } from './query-expansion';

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

const SOURCE_PRIORITY: Record<NonNullable<RetrievalResult['source']>, number> = {
  hybrid: 3,
  vector: 2,
  keyword: 1,
};
const MIN_DIVERSE_FUSION_RATIO = 0.6;
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
  ): Promise<RetrievalResult[]> {
    await this.initialize();
    const operationId = uuidv4();
    const expandedQuery = expandRetrievalQuery(query);
    const allowed = new Set(knowledgeTypes);
    const merged = new Map<string, RetrievalResult>();
    const candidateLimit = Math.min(
      MAX_CANDIDATE_POOL,
      Math.max(MIN_CANDIDATE_POOL, topK * CANDIDATE_MULTIPLIER),
    );

    if (this.vectorStore.stats().indexedCount > 0) {
      try {
        const embeddings = await this.embedTexts([expandedQuery]);
        const queryEmbedding = embeddings[0];
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
      } catch (error) {
        logger.warn({
          operationId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge vector query failed; using keyword fallback');
        // Keyword retrieval remains available when query embedding fails.
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
        const keywordFusionScore = this.rrfScore(
          keywordRank,
          KEYWORD_RRF_WEIGHT,
        );
        if (existing) {
          merged.set(key, {
            ...existing,
            source: 'hybrid',
            keywordScore,
            keywordRank,
            fusionScore: (existing.fusionScore ?? 0) + keywordFusionScore,
            similarity: Math.max(existing.vectorScore ?? existing.similarity, keywordScore),
          });
        } else {
          merged.set(key, {
            ...result,
            source: 'keyword',
            keywordScore,
            keywordRank,
            fusionScore: keywordFusionScore,
            similarity: keywordScore,
          });
        }
      }
    }

    const ranked = [...merged.values()].sort((a, b) => this.compare(a, b));
    return this.selectDiverseResults(ranked, topK, knowledgeTypes);
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
    const fusionDelta = (b.fusionScore ?? 0) - (a.fusionScore ?? 0);
    if (fusionDelta !== 0) return fusionDelta;
    const sourceDelta = SOURCE_PRIORITY[b.source ?? 'keyword'] - SOURCE_PRIORITY[a.source ?? 'keyword'];
    if (sourceDelta !== 0) return sourceDelta;
    return this.resultKey(a).localeCompare(this.resultKey(b));
  }

  private rrfScore(rank: number, weight: number): number {
    return weight / (RRF_RANK_CONSTANT + rank);
  }

  private isDirectFaqCandidate(result: RetrievalResult): boolean {
    return result.knowledgeType === 'faq'
      && (result.source === 'keyword' || result.source === 'hybrid')
      && (result.keywordScore ?? result.similarity) >= 0.65;
  }

  private selectDiverseResults(
    ranked: RetrievalResult[],
    topK: number,
    knowledgeTypes: KnowledgeType[],
  ): RetrievalResult[] {
    if (topK <= 1 || knowledgeTypes.length <= 1 || ranked.length <= 1) {
      return ranked.slice(0, topK);
    }
    const first = ranked[0];
    const selected = [first];
    const selectedKeys = new Set([this.resultKey(first)]);
    const fusionFloor = (first.fusionScore ?? 0) * MIN_DIVERSE_FUSION_RATIO;

    for (const knowledgeType of knowledgeTypes) {
      if (selected.some((result) => result.knowledgeType === knowledgeType)) continue;
      const candidate = ranked.find((result) => (
        result.knowledgeType === knowledgeType
        && (result.fusionScore ?? 0) >= fusionFloor
      ));
      if (!candidate) continue;
      selected.push(candidate);
      selectedKeys.add(this.resultKey(candidate));
      if (selected.length >= topK) return selected;
    }

    for (const result of ranked) {
      const key = this.resultKey(result);
      if (selectedKeys.has(key)) continue;
      selected.push(result);
      selectedKeys.add(key);
      if (selected.length >= topK) break;
    }
    return selected;
  }
}
