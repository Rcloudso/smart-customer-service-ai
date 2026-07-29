import { v4 as uuidv4 } from 'uuid';
import { KnowledgeType, RetrievalResult } from '../types/ai';
import { logger } from '../utils/logger';
import { VectorRecord, VectorSearchResult, VectorStore } from './vector-store';
import { expandRetrievalQuery } from './query-expansion';
import { rankRetrievalResults } from './retrieval-ranking';
import type { RetrievalPolicyConfig } from '../types/quality';

export interface KnowledgeIndexItem {
  id: string;
  result: RetrievalResult;
  embedding: number[];
  revision?: string;
}

export interface KnowledgeIndexLoad {
  items: KnowledgeIndexItem[];
  rollbackPersisted?: () => void;
}

export interface KnowledgeAdapter {
  readonly knowledgeType: KnowledgeType;
  getEmbeddingProfile?(): string;
  loadIndexItems(): Promise<KnowledgeIndexItem[] | KnowledgeIndexLoad>;
  hydrateVectorMatches?(matches: VectorSearchResult[]): Promise<Map<string, KnowledgeIndexItem>>;
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
    private readonly vectorStore: VectorStore,
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
        if (this.vectorStore.supportsStartupSync) {
          await this.vectorStore.delete([...previousItems.keys()], operationId);
          await this.vectorStore.upsertBatch(
            [...nextItems.values()].map((item) => this.toVectorRecord(item)),
            operationId,
          );
        }
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
          if (this.vectorStore.supportsStartupSync) {
            await this.vectorStore.delete([...nextItems.keys()], operationId);
            await this.vectorStore.upsertBatch(
              [...previousItems.values()].map((item) => this.toVectorRecord(item)),
              operationId,
            );
          }
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

  stats(): ReturnType<VectorStore['stats']> {
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

  async upsertIndexItem(item: KnowledgeIndexItem): Promise<void> {
    await this.vectorStore.upsertBatch([this.toVectorRecord(item)]);
    const items = this.indexedItems.get(item.result.knowledgeType) ?? new Map<string, KnowledgeIndexItem>();
    items.set(item.id, item);
    this.indexedItems.set(item.result.knowledgeType, items);
    const ids = this.indexedIds.get(item.result.knowledgeType) ?? new Set<string>();
    ids.add(item.id);
    this.indexedIds.set(item.result.knowledgeType, ids);
  }

  async replaceDocumentIndexItems(
    documentId: string,
    nextItems: KnowledgeIndexItem[],
  ): Promise<void> {
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
      await this.vectorStore.delete(previousDocumentItems.map((item) => item.id));
      await this.vectorStore.upsertBatch(nextItems.map((item) => this.toVectorRecord(item)));
    } catch (error) {
      try {
        await this.vectorStore.delete(nextItems.map((item) => item.id));
        await this.vectorStore.upsertBatch(
          previousDocumentItems.map((item) => this.toVectorRecord(item)),
        );
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

  async deleteIndexItem(knowledgeType: KnowledgeType, namespacedId: string): Promise<void> {
    await this.vectorStore.delete([namespacedId]);
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
    try {
      if ((await this.vectorStore.stats()).indexedCount === 0) {
        return queries.map(() => undefined);
      }
      return await this.embedTexts(queries);
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        queryCount: queries.length,
      }, 'Knowledge vector preparation failed; using keyword fallback');
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
      let vectorCandidates: Awaited<ReturnType<VectorStore['search']>> = [];
      try {
        vectorCandidates = (await Promise.all([...allowed].map((knowledgeType) => (
          this.vectorStore.search(queryEmbedding, {
            limit: candidateLimit,
            knowledgeTypes: [knowledgeType],
            traceId: operationId,
          })
        )))).flat().sort((left, right) => right.score - left.score);
      } catch (error) {
        logger.warn({
          operationId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'Knowledge vector search failed; using keyword fallback');
      }
      const hydrated = await this.hydrateVectorCandidates(vectorCandidates, allowed, operationId);
      for (const [index, match] of vectorCandidates.entries()) {
        const adapter = this.adapters.find((candidate) => (
          candidate.knowledgeType === match.knowledgeType
        ));
        const item = hydrated.get(match.id);
        if (
          !adapter
          || !item
          || this.itemRevision(item) !== match.revision
          || (adapter.getEmbeddingProfile?.() ?? 'legacy') !== match.embeddingProfile
        ) continue;
        const vectorScore = match.score;
        const vectorRank = index + 1;
        merged.set(this.resultKey(item.result), {
          ...item.result,
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

  private toVectorRecord(item: KnowledgeIndexItem): VectorRecord {
    const adapter = this.adapters.find((candidate) => (
      candidate.knowledgeType === item.result.knowledgeType
    ));
    return {
      id: item.id,
      knowledgeType: item.result.knowledgeType,
      revision: this.itemRevision(item),
      embeddingProfile: adapter?.getEmbeddingProfile?.() ?? 'legacy',
      embedding: item.embedding,
    };
  }

  private async hydrateVectorCandidates(
    matches: VectorSearchResult[],
    allowed: Set<KnowledgeType>,
    operationId: string,
  ): Promise<Map<string, KnowledgeIndexItem>> {
    const hydrated = new Map<string, KnowledgeIndexItem>();
    await Promise.all(this.adapters
      .filter((adapter) => allowed.has(adapter.knowledgeType))
      .map(async (adapter) => {
        const adapterMatches = matches.filter((match) => (
          match.knowledgeType === adapter.knowledgeType
        ));
        if (adapterMatches.length === 0) return;
        try {
          const items = adapter.hydrateVectorMatches
            ? await adapter.hydrateVectorMatches(adapterMatches)
            : this.indexedItems.get(adapter.knowledgeType) ?? new Map();
          for (const [id, item] of items) hydrated.set(id, item);
        } catch (error) {
          logger.warn({
            operationId,
            knowledgeType: adapter.knowledgeType,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }, 'Knowledge vector matches could not be hydrated');
        }
      }));
    return hydrated;
  }

  private itemRevision(item: KnowledgeIndexItem): string {
    return item.revision ?? 'legacy';
  }

}
