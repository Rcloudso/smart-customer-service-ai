import { getLLMClient } from './llm-client';
import { InMemoryVectorStore, VectorStore } from './vector-store';
import { getDatabase } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqDebugMatch, FaqDebugResult, FaqIndexStatus, FaqMatch } from '../types/ai';
import { FaqEntry } from '../types/domain';
import { logger } from '../utils/logger';

const KEYWORD_MATCH_SCORE = 0.55;
const KEYWORD_EXACT_MATCH_SCORE = 0.95;
const EMBEDDING_BATCH_SIZE = 100;
const HYBRID_SOURCE_PRIORITY: Record<NonNullable<FaqMatch['source']>, number> = {
  hybrid: 3,
  vector: 2,
  keyword: 1,
};

export function buildFaqEmbeddingText(entry: FaqEntry): string {
  return [
    `Question: ${entry.question}`,
    `Answer: ${entry.answer}`,
    `Keywords: ${entry.keywords.join(' ')}`,
  ].join('\n');
}

class SemanticSearch {
  private faqRepo: FaqRepo;
  private vectorStore: VectorStore;
  private initialized: boolean;
  private lastRebuiltAt: string | null;
  private lastError: string | null;

  constructor(vectorStore: VectorStore = new InMemoryVectorStore()) {
    const db = getDatabase();
    this.faqRepo = new FaqRepo(db);
    this.vectorStore = vectorStore;
    this.initialized = false;
    this.lastRebuiltAt = null;
    this.lastError = null;
  }

  async initialize(force: boolean = false): Promise<void> {
    if (this.initialized && !force) {
      return;
    }

    this.vectorStore.clear();

    try {
      const entries = this.faqRepo.listAllActive();
      const entriesWithEmbeddings = entries.filter((e) => e.embedding && e.embedding.length > 0);
      const entriesWithoutEmbeddings = entries.filter((e) => !e.embedding || e.embedding.length === 0);

      for (const entry of entriesWithEmbeddings) {
        if (entry.embedding) {
          this.vectorStore.upsert(entry, entry.embedding);
        }
      }

      if (entriesWithoutEmbeddings.length > 0) {
        logger.info({ count: entriesWithoutEmbeddings.length }, 'Generating embeddings for FAQ entries');
        await this.embedAndStore(entriesWithoutEmbeddings);
      }

      this.initialized = true;
      this.lastRebuiltAt = new Date().toISOString();
      this.lastError = null;
      logger.info({ indexSize: this.vectorStore.stats().indexedCount }, 'Semantic search index initialized');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.initialized = true;
      logger.error({ err }, 'Failed to initialize semantic search index');
    }
  }

  async rebuildIndex(): Promise<FaqIndexStatus> {
    this.initialized = false;
    await this.initialize(true);
    return this.getStatus();
  }

  getStatus(): FaqIndexStatus {
    const activeEntries = this.faqRepo.listAllActive();
    const stats = this.vectorStore.stats();

    return {
      initialized: this.initialized,
      activeCount: activeEntries.length,
      indexedCount: stats.indexedCount,
      missingEmbeddingCount: activeEntries.filter((entry) => !entry.embedding || entry.embedding.length === 0).length,
      embeddingDimensions: stats.embeddingDimensions,
      lastRebuiltAt: this.lastRebuiltAt ?? stats.updatedAt,
      lastError: this.lastError,
    };
  }

  async search(query: string, topK: number = 5): Promise<FaqMatch[]> {
    try {
      await this.initialize();
      const merged = new Map<string, FaqMatch>();

      const vectorMatches = await this.semanticSearch(query, topK);
      for (const match of vectorMatches) {
        merged.set(match.id, match);
      }

      const keywordMatches = this.fallbackSearch(query, topK);
      for (const match of keywordMatches) {
        const existing = merged.get(match.id);
        if (existing) {
          const vectorScore = existing.vectorScore ?? existing.similarity;
          const keywordScore = match.keywordScore ?? KEYWORD_MATCH_SCORE;
          merged.set(match.id, {
            ...existing,
            source: 'hybrid',
            vectorScore,
            keywordScore,
            similarity: Math.max(vectorScore, keywordScore),
          });
        } else {
          merged.set(match.id, match);
        }
      }

      return [...merged.values()]
        .sort((a, b) => this.compareMatches(a, b))
        .slice(0, topK);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Hybrid FAQ search failed, using keyword fallback');
      return this.fallbackSearch(query, topK);
    }
  }

  async debugSearch(query: string, topK: number = 5): Promise<FaqDebugResult> {
    const matches = await this.search(query, topK);
    return {
      query,
      topK,
      generatedAt: new Date().toISOString(),
      indexStatus: this.getStatus(),
      matches: matches.map((match, index) => this.toDebugMatch(match, index)),
    };
  }

  private async semanticSearch(query: string, topK: number): Promise<FaqMatch[]> {
    if (this.vectorStore.stats().indexedCount === 0) {
      return [];
    }

    const llmClient = getLLMClient();
    const queryEmbedResult = await llmClient.embed([query]);
    const queryEmbedding = queryEmbedResult[0]?.embedding;

    if (!queryEmbedding) {
      return [];
    }

    return this.vectorStore.search(queryEmbedding, topK).map((result) => ({
      id: result.entry.id,
      question: result.entry.question,
      answer: result.entry.answer,
      similarity: result.score,
      source: 'vector',
      vectorScore: result.score,
    }));
  }

  private fallbackSearch(query: string, topK: number): FaqMatch[] {
    logger.debug({ query, topK }, 'Using LIKE fallback search');
    const results = this.faqRepo.searchLike(query, topK);
    return results.map((entry) => {
      const keywordScore = this.keywordScore(query, entry);
      return {
        id: entry.id,
        question: entry.question,
        answer: entry.answer,
        similarity: keywordScore,
        source: 'keyword',
        keywordScore,
      };
    });
  }

  private keywordScore(query: string, entry: FaqEntry): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return KEYWORD_MATCH_SCORE;
    }

    const haystack = [
      entry.question,
      entry.answer,
      entry.keywords.join(' '),
    ].join(' ').toLowerCase();

    if (haystack.includes(normalizedQuery)) {
      return KEYWORD_EXACT_MATCH_SCORE;
    }

    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return KEYWORD_MATCH_SCORE;
    }

    const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
    return KEYWORD_MATCH_SCORE + Math.min(0.1, matchedTerms / terms.length * 0.1);
  }

  private compareMatches(a: FaqMatch, b: FaqMatch): number {
    const aScore = Math.max(a.vectorScore ?? 0, a.keywordScore ?? 0, a.similarity);
    const bScore = Math.max(b.vectorScore ?? 0, b.keywordScore ?? 0, b.similarity);
    const scoreDelta = bScore - aScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return HYBRID_SOURCE_PRIORITY[b.source ?? 'keyword'] - HYBRID_SOURCE_PRIORITY[a.source ?? 'keyword'];
  }

  private toDebugMatch(match: FaqMatch, index: number): FaqDebugMatch {
    const vectorScore = match.vectorScore ?? 0;
    const keywordScore = match.keywordScore ?? 0;
    const bestScore = Math.max(vectorScore, keywordScore, match.similarity);
    const matchedBy: Array<'vector' | 'keyword'> = [];
    if (match.source === 'vector' || match.source === 'hybrid') {
      matchedBy.push('vector');
    }
    if (match.source === 'keyword' || match.source === 'hybrid') {
      matchedBy.push('keyword');
    }

    const source = match.source ?? 'keyword';
    return {
      ...match,
      rank: index + 1,
      bestScore,
      matchedBy,
      rankingReason: `${source} match ranked by best score ${bestScore.toFixed(3)}`,
    };
  }

  async updateIndex(entry: FaqEntry): Promise<void> {
    this.vectorStore.delete(entry.id);

    if (!entry.isActive) {
      return;
    }

    try {
      await this.embedAndStore([entry]);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err, entryId: entry.id }, 'Failed to update index for entry');
    }
  }

  async updateIndexBatch(entries: FaqEntry[]): Promise<void> {
    const activeEntries: FaqEntry[] = [];

    for (const entry of entries) {
      this.vectorStore.delete(entry.id);
      if (entry.isActive) {
        activeEntries.push(entry);
      }
    }

    if (activeEntries.length === 0) {
      return;
    }

    try {
      await this.embedAndStore(activeEntries);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err, count: activeEntries.length }, 'Failed to update index for FAQ batch');
    }
  }

  private async embedAndStore(entries: FaqEntry[]): Promise<void> {
    const llmClient = getLLMClient();

    for (let i = 0; i < entries.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = entries.slice(i, i + EMBEDDING_BATCH_SIZE);
      const results = await llmClient.embed(batch.map((entry) => buildFaqEmbeddingText(entry)));

      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const embedding = results[j]?.embedding;
        if (embedding) {
          const updated = this.faqRepo.updateEmbedding(entry.id, embedding) ?? { ...entry, embedding };
          this.vectorStore.upsert(updated, embedding);
        }
      }
    }
  }
}

export const semanticSearch = new SemanticSearch();
