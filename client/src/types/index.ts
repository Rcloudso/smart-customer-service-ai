/**
 * Client-side type definitions — mirrors server types needed by the frontend.
 * These types are duplicative of server/types/ to avoid cross-boundary imports
 * (Vite's root is "client" and tsconfig excludes "server").
 */

// ── Enums ──────────────────────────────────────────

export enum SessionStatus {
  ACTIVE = 'active',
  CLOSED = 'closed',
  ESCALATED = 'escalated',
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum IntentCategory {
  REFUND = 'refund',
  ORDER = 'order',
  TECHNICAL = 'technical',
  GENERAL = 'general',
}

export enum SatisfactionRating {
  VERY_UNSATISFIED = 1,
  UNSATISFIED = 2,
  NEUTRAL = 3,
  SATISFIED = 4,
  VERY_SATISFIED = 5,
}

export enum EscalationStatus {
  PENDING = 'pending',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

export type KnowledgeReviewStatus = 'pending' | 'converted' | 'dismissed';
export type KnowledgeReviewTriggerReason = 'no_match' | 'low_retrieval_score' | 'negative_feedback';

export interface KnowledgeRetrievalSnapshot {
  knowledgeType: 'faq';
  knowledgeId: string;
  title: string;
  source?: 'vector' | 'keyword' | 'hybrid';
  similarity: number;
  keywordScore?: number;
  vectorScore?: number;
}

export interface KnowledgeReviewItem {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  question: string;
  answer: string;
  intent: IntentCategory | null;
  intentConf: number | null;
  retrievalSnapshot: KnowledgeRetrievalSnapshot[];
  triggerReason: KnowledgeReviewTriggerReason;
  rating: SatisfactionRating | null;
  status: KnowledgeReviewStatus;
  linkedFaqId: string | null;
  dismissReason: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface KnowledgeReviewStats {
  pending: number;
  converted: number;
  dismissed: number;
  total: number;
}

// ── Domain Models ──────────────────────────────────

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
  embedding: number[] | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
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

export interface FaqDebugMatch {
  id: string;
  question: string;
  answer: string;
  similarity: number;
  source?: 'vector' | 'keyword' | 'hybrid';
  vectorScore?: number;
  keywordScore?: number;
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

// ── Model Config Types ─────────────────────────────

export interface ModelConfigDTO {
  llmApiBase: string;
  llmModel: string;
  llmApiKey: string;
  embedProvider: string;
  embedApiBase: string;
  embedModel: string;
  embedApiKey: string;
}

export interface ModelConfigResponseDTO extends ModelConfigDTO {
  llmApiKeyOverridden: boolean;
  embedApiKeyOverridden: boolean;
}

// ── API Types ──────────────────────────────────────

export interface ApiResponse<T = unknown> {
  code: number;
  data: T;
  message: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    role: string;
  };
}

export interface PaginationResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminOverview {
  totalConversations: number;
  totalMessages: number;
  avgSatisfaction: number;
  escalationRate: number;
  activeSessions: number;
}

export interface SatisfactionTrend {
  date: string;
  avgRating: number;
  count: number;
}

export interface IntentDistribution {
  intent: IntentCategory;
  count: number;
  percentage: number;
}

export interface ConversationDetail {
  session: {
    id: string;
    userIdent: string;
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    role: MessageRole;
    content: string;
    intent: IntentCategory | null;
    intentConf: number | null;
    satisfaction: SatisfactionRating | null;
    escalated: number;
    createdAt: string;
  }>;
  escalation: {
    id: string;
    reason: string;
    status: EscalationStatus;
    createdAt: string;
  } | null;
}

export interface ChatHistorySession {
  id: string;
  userIdent: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  messageCount: number;
  preview: string | null;
}
