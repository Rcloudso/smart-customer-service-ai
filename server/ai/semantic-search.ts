import { getDatabase } from '../db';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqDebugMatch, FaqDebugResult, FaqIndexStatus, FaqMatch } from '../types/ai';
import { FaqEntry } from '../types/domain';
import { logger } from '../utils/logger';
import { buildFaqEmbeddingText, persistCurrentFaqEmbedding } from './knowledge-adapters';
import {
  FAQ_EMBEDDING_INPUT_VERSION,
  currentEmbeddingProfile,
} from './embedding-profile';
import { faqKnowledgeAdapter, knowledgeRetriever } from './knowledge-system';
import { getLLMClient } from './llm-client';

const EMBEDDING_BATCH_SIZE = 100;

export interface PreparedFaqIndex {
  embedding: number[];
  embeddingProfile: string;
}

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
      const failedSources = knowledgeRetriever.getFailedSources();
      this.initialized = !failedSources.includes('faq');
      this.lastRebuiltAt = new Date().toISOString();
      this.lastError = this.initialized ? null : 'FAQ vector index is degraded; keyword fallback remains available';
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
    const isDegraded = knowledgeRetriever.getFailedSources().includes('faq');
    return {
      initialized: knowledgeRetriever.hasInitialized() && !isDegraded,
      activeCount: activeEntries.length,
      indexedCount: knowledgeRetriever.getIndexedCount('faq'),
      missingEmbeddingCount: activeEntries.filter((entry) => (
        !entry.embedding?.length
        || entry.embeddingProfile !== currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION)
      )).length,
      embeddingDimensions: stats.embeddingDimensions,
      lastRebuiltAt: this.lastRebuiltAt ?? stats.updatedAt,
      lastError: isDegraded
        ? this.lastError ?? 'FAQ vector index is degraded; keyword fallback remains available'
        : null,
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
      fusionScore: result.fusionScore,
      vectorRank: result.vectorRank,
      keywordRank: result.keywordRank,
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

  async prepareIndex(entry: FaqEntry): Promise<PreparedFaqIndex> {
    const result = await getLLMClient().embed([buildFaqEmbeddingText(entry)]);
    const embedding = result[0]?.embedding;
    if (!embedding) throw new Error('Embedding result was empty');
    return {
      embedding,
      embeddingProfile: currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION),
    };
  }

  commitPreparedIndex(entry: FaqEntry): void {
    knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
    if (entry.isActive && entry.embedding) {
      knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(entry));
    }
  }

  async updateIndex(entry: FaqEntry): Promise<void> {
    if (!entry.isActive) {
      knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
      return;
    }
    try {
      const updated = await persistCurrentFaqEmbedding(
        entry,
        this.faqRepo,
        (current) => this.prepareIndex(current),
      );
      if (!updated || !updated.isActive) {
        knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
        return;
      }
      knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(updated));
    } catch (error) {
      knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, entryId: entry.id }, 'Failed to update FAQ index entry');
    }
  }

  async updateIndexBatch(entries: FaqEntry[]): Promise<void> {
    const active = entries.filter((entry) => entry.isActive);
    const currentProfile = currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION);
    for (const entry of entries) knowledgeRetriever.deleteIndexItem('faq', `faq:${entry.id}`);
    const updates: Array<{
      id: string;
      embedding: number[];
      embeddingProfile: string;
      expectedUpdatedAt: string;
    }> = [];
    for (let i = 0; i < active.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = active.slice(i, i + EMBEDDING_BATCH_SIZE);
      const missing = batch.filter((entry) => (
        !entry.embedding?.length || entry.embeddingProfile !== currentProfile
      ));
      let generated: number[][] = [];
      if (missing.length > 0) {
        const results = await getLLMClient().embed(missing.map(buildFaqEmbeddingText));
        generated = results.map((result) => result.embedding);
      }
      for (const [index, entry] of missing.entries()) {
        const embedding = generated[index];
        if (!embedding?.length) throw new Error('Embedding result was empty');
        updates.push({
          id: entry.id,
          embedding,
          embeddingProfile: currentProfile,
          expectedUpdatedAt: entry.updatedAt,
        });
      }
    }
    if (updates.length > 0) this.faqRepo.updateEmbeddings(updates);
    const refreshed = new Map(this.faqRepo.listAllActive().map((entry) => [entry.id, entry]));
    for (const entry of active) {
      const indexedEntry = refreshed.get(entry.id) ?? entry;
      knowledgeRetriever.upsertIndexItem(faqKnowledgeAdapter.toIndexItem(indexedEntry));
    }
  }

  private toDebugMatch(match: FaqMatch, index: number): FaqDebugMatch {
    const vectorScore = match.vectorScore ?? 0;
    const keywordScore = match.keywordScore ?? 0;
    const bestScore = match.fusionScore ?? Math.max(vectorScore, keywordScore, match.similarity);
    const matchedBy: Array<'vector' | 'keyword'> = [];
    if (match.source === 'vector' || match.source === 'hybrid') matchedBy.push('vector');
    if (match.source === 'keyword' || match.source === 'hybrid') matchedBy.push('keyword');
    return {
      ...match,
      rank: index + 1,
      bestScore,
      matchedBy,
      rankingReason: match.fusionScore === undefined
        ? `${match.source ?? 'keyword'} match ranked by best score ${bestScore.toFixed(3)}`
        : `${match.source ?? 'keyword'} match fused by RRF ${bestScore.toFixed(4)}`
          + ` (vector rank ${match.vectorRank ?? '-'}, keyword rank ${match.keywordRank ?? '-'})`,
    };
  }
}

export const semanticSearch = new SemanticSearch();
