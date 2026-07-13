import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqEntry } from '../types/domain';
import { RetrievalResult } from '../types/ai';
import { getLLMClient } from './llm-client';
import { KnowledgeAdapter, KnowledgeIndexItem } from './knowledge-retriever';

const EMBEDDING_BATCH_SIZE = 100;
const KEYWORD_MATCH_SCORE = 0.55;
const KEYWORD_EXACT_MATCH_SCORE = 0.95;

export function buildFaqEmbeddingText(entry: FaqEntry): string {
  return [
    `Question: ${entry.question}`,
    `Answer: ${entry.answer}`,
    `Keywords: ${entry.keywords.join(' ')}`,
  ].join('\n');
}

export class FaqKnowledgeAdapter implements KnowledgeAdapter {
  readonly knowledgeType = 'faq' as const;

  constructor(private readonly repo: FaqRepo) {}

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    const entries = this.repo.listAllActive();
    const missing = entries.filter((entry) => !entry.embedding || entry.embedding.length === 0);
    for (let index = 0; index < missing.length; index += EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(index, index + EMBEDDING_BATCH_SIZE);
      const embeddings = await getLLMClient().embed(batch.map(buildFaqEmbeddingText));
      batch.forEach((entry, batchIndex) => {
        const embedding = embeddings[batchIndex]?.embedding;
        if (embedding) this.repo.updateEmbedding(entry.id, embedding);
      });
    }
    return this.repo.listAllActive()
      .filter((entry) => entry.embedding && entry.embedding.length > 0)
      .map((entry) => this.toIndexItem(entry));
  }

  searchKeyword(query: string, limit: number): RetrievalResult[] {
    return this.repo.searchLike(query, limit).map((entry) => {
      const keywordScore = keywordScoreForFaq(query, entry);
      return {
        knowledgeType: 'faq',
        knowledgeId: entry.id,
        title: entry.question,
        content: entry.answer,
        similarity: keywordScore,
        source: 'keyword',
        keywordScore,
      };
    });
  }

  toIndexItem(entry: FaqEntry): KnowledgeIndexItem {
    return {
      id: `faq:${entry.id}`,
      result: {
        knowledgeType: 'faq',
        knowledgeId: entry.id,
        title: entry.question,
        content: entry.answer,
        similarity: 0,
      },
      embedding: entry.embedding ?? [],
    };
  }
}

export class DocumentKnowledgeAdapter implements KnowledgeAdapter {
  readonly knowledgeType = 'document' as const;

  constructor(private readonly repo: DocumentRepo) {}

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    return this.repo.listAllActiveKnowledgeChunks().map((chunk) => ({
      id: `document:${chunk.id}`,
      result: {
        knowledgeType: 'document',
        knowledgeId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.documentTitle,
        content: chunk.content,
        similarity: 0,
        chunkIndex: chunk.chunkIndex,
        pageStart: chunk.pageStart ?? undefined,
        pageEnd: chunk.pageEnd ?? undefined,
      },
      embedding: chunk.embedding,
    }));
  }

  searchKeyword(query: string, limit: number): RetrievalResult[] {
    return this.repo.searchActiveChunksLike(query, limit).map((chunk) => ({
      knowledgeType: 'document',
      knowledgeId: chunk.id,
      documentId: chunk.documentId,
      title: chunk.documentTitle,
      content: chunk.content,
      similarity: KEYWORD_EXACT_MATCH_SCORE,
      source: 'keyword',
      keywordScore: KEYWORD_EXACT_MATCH_SCORE,
      chunkIndex: chunk.chunkIndex,
      pageStart: chunk.pageStart ?? undefined,
      pageEnd: chunk.pageEnd ?? undefined,
    }));
  }
}

function keywordScoreForFaq(query: string, entry: FaqEntry): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return KEYWORD_MATCH_SCORE;
  const haystack = [entry.question, entry.answer, entry.keywords.join(' ')].join(' ').toLowerCase();
  if (haystack.includes(normalizedQuery)) return KEYWORD_EXACT_MATCH_SCORE;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return KEYWORD_MATCH_SCORE;
  const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
  return KEYWORD_MATCH_SCORE + Math.min(0.1, matchedTerms / terms.length * 0.1);
}
