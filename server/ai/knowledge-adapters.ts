import { DocumentRepo } from '../db/repos/document.repo';
import { FaqRepo } from '../db/repos/faq.repo';
import { FaqEntry } from '../types/domain';
import { RetrievalResult } from '../types/ai';
import { getLLMClient } from './llm-client';
import {
  KnowledgeAdapter,
  KnowledgeIndexItem,
  KnowledgeIndexLoad,
} from './knowledge-retriever';
import {
  DOCUMENT_EMBEDDING_INPUT_VERSION,
  FAQ_EMBEDDING_INPUT_VERSION,
  buildDocumentEmbeddingText,
  currentEmbeddingProfile,
} from './embedding-profile';

const EMBEDDING_BATCH_SIZE = 100;
const KEYWORD_MATCH_SCORE = 0.55;
const KEYWORD_EXACT_MATCH_SCORE = 0.95;
const DOCUMENT_KEYWORD_CANDIDATE_MULTIPLIER = 4;
const MAX_DOCUMENT_KEYWORD_CANDIDATES = 100;
const DOCUMENT_QUERY_STOP_TERMS = new Set([
  '你们', '我们', '您好', '请问', '什么', '如何', '怎么', '是否', '可以',
  '这个', '那个', '公司', '哪些', '有哪', '有哪些', '是什么',
]);
const DOCUMENT_QUERY_NOISE = /你们|我们|您好|请问|什么|如何|怎么|是否|可以|这个|那个|公司|有哪些|是什么/g;
type EmbedTexts = (texts: string[]) => Promise<number[][]>;

const embedWithConfiguredClient: EmbedTexts = async (texts) => (
  (await getLLMClient().embed(texts)).map((result) => result.embedding)
);

export function buildFaqEmbeddingText(entry: FaqEntry): string {
  return [
    `Question: ${entry.question}`,
    `Answer: ${entry.answer}`,
    `Keywords: ${entry.keywords.join(' ')}`,
  ].join('\n');
}

export async function persistCurrentFaqEmbedding(
  initialEntry: FaqEntry,
  repo: FaqRepo,
  prepare: (entry: FaqEntry) => Promise<{
    embedding: number[];
    embeddingProfile: string;
  }>,
  maxAttempts: number = 3,
): Promise<FaqEntry | null> {
  let entry = initialEntry;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!entry.isActive) return entry;
    const currentProfile = currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION);
    if (entry.embedding?.length && entry.embeddingProfile === currentProfile) {
      return entry;
    }

    const prepared = await prepare(entry);
    const updated = repo.updateEmbedding(
      entry.id,
      prepared.embedding,
      prepared.embeddingProfile,
      entry.updatedAt,
    );
    if (updated) return updated;

    const latest = repo.findById(entry.id);
    if (!latest) return null;
    entry = latest;
  }

  throw new Error('FAQ changed repeatedly while its embedding was being generated');
}

export class FaqKnowledgeAdapter implements KnowledgeAdapter {
  readonly knowledgeType = 'faq' as const;

  constructor(
    private readonly repo: FaqRepo,
    private readonly embedTexts: EmbedTexts = embedWithConfiguredClient,
  ) {}

  getEmbeddingProfile(): string {
    return currentEmbeddingProfile(FAQ_EMBEDDING_INPUT_VERSION);
  }

  async loadIndexItems(): Promise<KnowledgeIndexLoad> {
    const entries = this.repo.listAllActive();
    const embeddingProfile = this.getEmbeddingProfile();
    const stale = entries.filter((entry) => (
      !entry.embedding
      || entry.embedding.length === 0
      || entry.embeddingProfile !== embeddingProfile
    ));
    const updates: Array<{
      id: string;
      embedding: number[];
      embeddingProfile: string;
      expectedUpdatedAt: string;
    }> = [];
    for (let index = 0; index < stale.length; index += EMBEDDING_BATCH_SIZE) {
      const batch = stale.slice(index, index + EMBEDDING_BATCH_SIZE);
      const embeddings = await this.embedTexts(batch.map(buildFaqEmbeddingText));
      batch.forEach((entry, batchIndex) => {
        const embedding = embeddings[batchIndex];
        if (!embedding?.length) throw new Error('FAQ embedding result was empty');
        updates.push({
          id: entry.id,
          embedding,
          embeddingProfile,
          expectedUpdatedAt: entry.updatedAt,
        });
      });
    }
    if (updates.length > 0) this.repo.updateEmbeddings(updates);
    const items = this.repo.listAllActive()
      .filter((entry) => entry.embedding && entry.embedding.length > 0)
      .map((entry) => this.toIndexItem(entry));
    return {
      items,
      rollbackPersisted: updates.length > 0
        ? () => this.repo.updateEmbeddings(stale.map((entry) => ({
            id: entry.id,
            embedding: entry.embedding,
            embeddingProfile: entry.embeddingProfile,
            expectedUpdatedAt: entry.updatedAt,
          })))
        : undefined,
    };
  }

  searchKeyword(query: string, limit: number): RetrievalResult[] {
    return this.repo.searchLike(query, limit)
      .map((entry): RetrievalResult => {
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
      })
      .sort((left, right) => right.similarity - left.similarity);
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

  constructor(
    private readonly repo: DocumentRepo,
    private readonly embedTexts: EmbedTexts = embedWithConfiguredClient,
  ) {}

  getEmbeddingProfile(): string {
    return currentEmbeddingProfile(DOCUMENT_EMBEDDING_INPUT_VERSION);
  }

  async loadIndexItems(): Promise<KnowledgeIndexLoad> {
    const chunks = this.repo.listAllActiveKnowledgeChunks();
    const embeddingProfile = this.getEmbeddingProfile();
    const stale = chunks.filter((chunk) => (
      chunk.embedding.length === 0 || chunk.embeddingProfile !== embeddingProfile
    ));
    const updates: Array<{ id: string; embedding: number[]; embeddingProfile: string }> = [];
    for (let index = 0; index < stale.length; index += EMBEDDING_BATCH_SIZE) {
      const batch = stale.slice(index, index + EMBEDDING_BATCH_SIZE);
      const embeddings = await this.embedTexts(batch.map((chunk) => (
        buildDocumentEmbeddingText({
          documentTitle: chunk.documentTitle,
          sectionTitle: chunk.title,
          content: chunk.content,
        })
      )));
      batch.forEach((chunk, batchIndex) => {
        const embedding = embeddings[batchIndex];
        if (!embedding?.length) throw new Error('Document embedding result was empty');
        updates.push({ id: chunk.id, embedding, embeddingProfile });
      });
    }
    if (updates.length > 0) this.repo.updateKnowledgeChunkEmbeddings(updates);
    const items = this.repo.listAllActiveKnowledgeChunks().map((chunk): KnowledgeIndexItem => ({
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
    return {
      items,
      rollbackPersisted: updates.length > 0
        ? () => this.repo.updateKnowledgeChunkEmbeddings(stale.map((chunk) => ({
            id: chunk.id,
            embedding: chunk.embedding,
            embeddingProfile: chunk.embeddingProfile,
          })))
        : undefined,
    };
  }

  searchKeyword(query: string, limit: number): RetrievalResult[] {
    const terms = documentKeywordTerms(query);
    const candidateLimit = Math.min(
      MAX_DOCUMENT_KEYWORD_CANDIDATES,
      Math.max(limit, limit * DOCUMENT_KEYWORD_CANDIDATE_MULTIPLIER),
    );
    return this.repo.searchActiveChunksLikeTerms(terms, candidateLimit)
      .map((chunk): RetrievalResult => {
        const keywordScore = keywordScoreForDocument(query, terms, chunk);
        return {
          knowledgeType: 'document',
          knowledgeId: chunk.id,
          documentId: chunk.documentId,
          title: chunk.documentTitle,
          content: chunk.content,
          similarity: keywordScore,
          source: 'keyword',
          keywordScore,
          chunkIndex: chunk.chunkIndex,
          pageStart: chunk.pageStart ?? undefined,
          pageEnd: chunk.pageEnd ?? undefined,
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}

export function documentKeywordTerms(query: string): string[] {
  const segments = query.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*/gu) ?? [];
  const terms: string[] = [];
  for (const segment of segments) {
    const cleaned = /[\p{Script=Han}]/u.test(segment)
      ? segment.replace(DOCUMENT_QUERY_NOISE, '').replace(/^[的是]+|[的是]+$/g, '')
      : segment;
    if (cleaned.length < 2) continue;
    if (cleaned.length <= 32) terms.push(cleaned);
    if (!/[\p{Script=Han}]/u.test(cleaned) || cleaned.length < 2) continue;
    for (const size of [4, 2, 3]) {
      if (cleaned.length < size) continue;
      for (let index = 0; index <= cleaned.length - size; index += 1) {
        terms.push(cleaned.slice(index, index + size));
      }
    }
  }
  return [...new Set(terms)]
    .filter((term) => term.length >= 2 && !DOCUMENT_QUERY_STOP_TERMS.has(term))
    .slice(0, 24);
}

function keywordScoreForFaq(query: string, entry: FaqEntry): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return KEYWORD_MATCH_SCORE;
  const question = entry.question.toLowerCase();
  const answer = entry.answer.toLowerCase();
  const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());
  if (question.includes(normalizedQuery)) return KEYWORD_EXACT_MATCH_SCORE;
  if (keywords.some((keyword) => keyword.includes(normalizedQuery))) return 0.9;
  if (answer.includes(normalizedQuery)) return 0.7;
  const haystack = [question, answer, keywords.join(' ')].join(' ');
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return KEYWORD_MATCH_SCORE;
  const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
  return KEYWORD_MATCH_SCORE + Math.min(0.1, matchedTerms / terms.length * 0.1);
}

function keywordScoreForDocument(
  query: string,
  terms: string[],
  chunk: { content: string; title: string | null; documentTitle: string },
): number {
  const title = [chunk.documentTitle, chunk.title ?? ''].join(' ').toLowerCase();
  const content = chunk.content.toLowerCase();
  const haystack = `${title} ${content}`;
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery && haystack.includes(normalizedQuery)) return KEYWORD_EXACT_MATCH_SCORE;
  const weightedTerms = terms.map((term) => ({ term, weight: Math.max(2, term.length) }));
  const totalWeight = weightedTerms.reduce((sum, item) => sum + item.weight, 0) || 1;
  const matchedWeight = weightedTerms.reduce((sum, item) => (
    haystack.includes(item.term) ? sum + item.weight : sum
  ), 0);
  const titleWeight = weightedTerms.reduce((sum, item) => (
    title.includes(item.term) ? sum + item.weight : sum
  ), 0);
  return Math.min(
    KEYWORD_EXACT_MATCH_SCORE,
    0.55 + (matchedWeight / totalWeight) * 0.25 + (titleWeight / totalWeight) * 0.15,
  );
}
