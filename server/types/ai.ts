import { IntentCategory } from './domain';

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
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptContext {
  intent: IntentCategory;
  faqResults: FaqMatch[];
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
