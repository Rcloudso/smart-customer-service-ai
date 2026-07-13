import { getDatabase } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqDebugMatch, FaqDebugResult, FaqIndexStatus, FaqMatch } from '../types/ai';
import { FaqEntry } from '../types/domain';
import { logger } from '../utils/logger';
import { buildFaqEmbeddingText } from './knowledge-adapters';
import { faqKnowledgeAdapter, knowledgeRetriever } from './knowledge-system';
import { getLLMClient } from './llm-client';

const EMBEDDING_BATCH_SIZE = 100;

class SemanticSearch {
  private readonly faqRepo = new FaqRepo(getDatabase());
  private initialized = false;
  private lastRebuiltAt: string | null = null;
  private lastError: string | null = null;

  async initialize(force: boolean = false): Promise<void> {
    if (this.initialized && !force) return;
    try {
      if (force) await knowledgeRetriever.refreshSource('faq');
      else await knowledgeRetriever.initialize();
      this.initialized = true;
      this.lastRebuiltAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.initialized = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Failed to initialize semantic search index');
    }
  }

  async rebuildIndex(): Promise<FaqIndexStatus> {
    await this.initialize(true);
    return this.getStatus();
  }

  getStatus(): FaqIndexStatus {
    const activeEntries = this.faqRepo.listAllActive();
    const stats = knowledgeRetriever.stats();
    return {
      initialized: this.initialized,
      activeCount: activeEntries.length,
      indexedCount: knowledgeRetriever.getIndexedCount('faq'),
      missingEmbeddingCount: activeEntries.filter((entry) => !entry.embedding?.length).length,
      embeddingDimensions: stats.embeddingDimensions,
      lastRebuiltAt: this.lastRebuiltAt ?? stats.updatedAt,
      lastError: this.lastError,
    };
  }

  async search(query: string, topK: number = 5): Promise<FaqMatch[]> {
    const results = await knowledgeRetriever.search(query, topK, ['faq']);
    return results.map((result) => ({
      id: result.knowledgeId,
      question: result.title,
      answer: result.content,
      similarity: result.similarity,
      source: result.source,
      vectorScore: result.vectorScore,
      keywordScore: result.keywordScore,
    }));
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

  async prepareIndex(entry: FaqEntry): Promise<number[]> {
    const result = await getLLMClient().embed([buildFaqEmbeddingText(entry)]);
    const embedding = result[0]?.embedding;
    if (!embedding) throw new Error('Embedding result was empty');
    return embedding;
  }

  commitPreparedIndex(entry: FaqEntry): void {
    knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
    if (entry.isActive && entry.embedding) {
      knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(entry));
    }
  }

  async updateIndex(entry: FaqEntry): Promise<void> {
    knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
    if (!entry.isActive) return;
    try {
      const embedding = entry.embedding?.length ? entry.embedding : await this.prepareIndex(entry);
      const updated = entry.embedding?.length
        ? entry
        : this.faqRepo.updateEmbedding(entry.id, embedding) ?? { ...entry, embedding };
      knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(updated));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, entryId: entry.id }, 'Failed to update FAQ index entry');
    }
  }

  async updateIndexBatch(entries: FaqEntry[]): Promise<void> {
    const active = entries.filter((entry) => entry.isActive);
    for (const entry of entries) knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
    for (let i = 0; i < active.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = active.slice(i, i + EMBEDDING_BATCH_SIZE);
      const missing = batch.filter((entry) => !entry.embedding?.length);
      let generated: number[][] = [];
      if (missing.length > 0) {
        const results = await getLLMClient().embed(missing.map(buildFaqEmbeddingText));
        generated = results.map((result) => result.embedding);
      }
      let missingIndex = 0;
      for (const entry of batch) {
        let indexedEntry = entry;
        if (!entry.embedding?.length) {
          const embedding = generated[missingIndex++];
          if (!embedding) continue;
          indexedEntry = this.faqRepo.updateEmbedding(entry.id, embedding) ?? { ...entry, embedding };
        }
        knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(indexedEntry));
      }
    }
  }

  private toDebugMatch(match: FaqMatch, index: number): FaqDebugMatch {
    const vectorScore = match.vectorScore ?? 0;
    const keywordScore = match.keywordScore ?? 0;
    const bestScore = Math.max(vectorScore, keywordScore, match.similarity);
    const matchedBy: Array<'vector' | 'keyword'> = [];
    if (match.source === 'vector' || match.source === 'hybrid') matchedBy.push('vector');
    if (match.source === 'keyword' || match.source === 'hybrid') matchedBy.push('keyword');
    return {
      ...match,
      rank: index + 1,
      bestScore,
      matchedBy,
      rankingReason: `${match.source ?? 'keyword'} match ranked by best score ${bestScore.toFixed(3)}`,
    };
  }
}

export const semanticSearch = new SemanticSearch();
