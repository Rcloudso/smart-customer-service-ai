import { IntentCategory } from './domain';

export type KnowledgeType = 'faq' | 'document';

export interface RetrievalResult {
  knowledgeType: KnowledgeType;
  knowledgeId: string;
  documentId?: string;
  title: string;
  content: string;
  similarity: number;
  source?: 'vector' | 'keyword' | 'hybrid';
  vectorScore?: number;
  keywordScore?: number;
  chunkIndex?: number;
  pageStart?: number;
  pageEnd?: number;
}

export interface IntentResult {
  intent: IntentCategory;
  confidence: number;
  reasoning: string;
}

export interface FaqMatch {
  id: string;
  question: string;
  answer: string;
  similarity: number;
  source?: 'vector' | 'keyword' | 'hybrid';
  vectorScore?: number;
  keywordScore?: number;
}

export interface FaqDebugMatch extends FaqMatch {
  rank: number;
  bestScore: number;
  matchedBy: Array<'vector' | 'keyword'>;
  rankingReason: string;
}

export interface FaqDebugResult {
  query: string;
  topK: number;
  generatedAt: string;
  indexStatus: FaqIndexStatus;
  matches: FaqDebugMatch[];
}

export interface FaqIndexStatus {
  initialized: boolean;
  activeCount: number;
  indexedCount: number;
  missingEmbeddingCount: number;
  embeddingDimensions: number | null;
  lastRebuiltAt: string | null;
  lastError: string | null;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptContext {
  intent: IntentCategory;
  knowledgeResults: RetrievalResult[];
  userQuestion: string;
  conversationSummary: string | null;
  shouldOfferEscalation: boolean;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
}

export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}
