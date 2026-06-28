import { getLLMClient } from './llm-client';
import { getDatabase } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqMatch } from '../types/ai';
import { FaqEntry } from '../types/domain';
import { logger } from '../utils/logger';

class SemanticSearch {
  private faqRepo: FaqRepo;
  private index: Map<string, { entry: FaqEntry; embedding: number[] }>;
  private initialized: boolean;

  constructor() {
    const db = getDatabase();
    this.faqRepo = new FaqRepo(db);
    this.index = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const entries = this.faqRepo.listAllActive();
      const entriesWithEmbeddings = entries.filter((e) => e.embedding && e.embedding.length > 0);
      const entriesWithoutEmbeddings = entries.filter((e) => !e.embedding || e.embedding.length === 0);

      // Load entries that already have embeddings
      for (const entry of entriesWithEmbeddings) {
        if (entry.embedding) {
          this.index.set(entry.id, { entry, embedding: entry.embedding });
        }
      }

      // Generate embeddings for entries without them
      if (entriesWithoutEmbeddings.length > 0) {
        logger.info({ count: entriesWithoutEmbeddings.length }, 'Generating embeddings for FAQ entries');
        try {
          const llmClient = getLLMClient();
          const texts = entriesWithoutEmbeddings.map((e) => e.question);
          const results = await llmClient.embed(texts);

          for (let i = 0; i < entriesWithoutEmbeddings.length; i++) {
            const entry = entriesWithoutEmbeddings[i];
            const embedding = results[i]?.embedding;
            if (embedding) {
              this.faqRepo.update(entry.id, { embedding });
              this.index.set(entry.id, { entry, embedding });
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to generate embeddings, will use fallback search');
        }
      }

      this.initialized = true;
      logger.info({ indexSize: this.index.size }, 'Semantic search index initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize semantic search index');
      this.initialized = true; // Mark as initialized to avoid repeated failures
    }
  }

  async search(query: string, topK: number = 5): Promise<FaqMatch[]> {
    try {
      if (this.index.size > 0) {
        return await this.semanticSearch(query, topK);
      }
      return this.fallbackSearch(query, topK);
    } catch (err) {
      logger.warn({ err }, 'Semantic search failed, using fallback');
      return this.fallbackSearch(query, topK);
    }
  }

  private async semanticSearch(query: string, topK: number): Promise<FaqMatch[]> {
    const llmClient = getLLMClient();
    const queryEmbedResult = await llmClient.embed([query]);
    const queryEmbedding = queryEmbedResult[0]?.embedding;

    if (!queryEmbedding) {
      return this.fallbackSearch(query, topK);
    }

    const scored: FaqMatch[] = [];

    for (const [, item] of this.index) {
      const similarity = this.cosineSimilarity(queryEmbedding, item.embedding);
      scored.push({
        id: item.entry.id,
        question: item.entry.question,
        answer: item.entry.answer,
        similarity,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  private fallbackSearch(query: string, topK: number): FaqMatch[] {
    logger.debug({ query, topK }, 'Using LIKE fallback search');
    const results = this.faqRepo.searchLike(query, topK);
    return results.map((entry) => ({
      id: entry.id,
      question: entry.question,
      answer: entry.answer,
      similarity: 0.5, // Default similarity for LIKE results
    }));
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

  async updateIndex(entry: FaqEntry): Promise<void> {
    if (!entry.isActive) {
      this.index.delete(entry.id);
      return;
    }

    try {
      const llmClient = getLLMClient();
      const results = await llmClient.embed([entry.question]);
      const embedding = results[0]?.embedding;

      if (embedding) {
        this.faqRepo.update(entry.id, { embedding });
        this.index.set(entry.id, { entry, embedding });
      }
    } catch (err) {
      logger.warn({ err, entryId: entry.id }, 'Failed to update index for entry');
    }
  }

  async updateIndexBatch(entries: FaqEntry[]): Promise<void> {
    const activeEntries: FaqEntry[] = [];

    for (const entry of entries) {
      if (!entry.isActive) {
        this.index.delete(entry.id);
      } else {
        activeEntries.push(entry);
      }
    }

    if (activeEntries.length === 0) {
      return;
    }

    try {
      const llmClient = getLLMClient();
      const results = await llmClient.embed(activeEntries.map((entry) => entry.question));

      for (let i = 0; i < activeEntries.length; i++) {
        const entry = activeEntries[i];
        const embedding = results[i]?.embedding;
        if (embedding) {
          this.faqRepo.update(entry.id, { embedding });
          this.index.set(entry.id, { entry, embedding });
        }
      }
    } catch (err) {
      logger.warn({ err, count: activeEntries.length }, 'Failed to update index for FAQ batch');
    }
  }
}

export const semanticSearch = new SemanticSearch();
