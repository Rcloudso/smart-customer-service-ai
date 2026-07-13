import { IntentCategory, MessageRole, SessionStatus, SatisfactionRating, EscalationStatus } from './domain';

// ---- Generic API envelope ----
export interface ApiResponse<T = unknown> {
  code: number;
  data: T;
  message: string;
}

// ---- Auth ----
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

// ---- Chat SSE ----
export interface ChatRequest {
  message: string;
  sessionId?: string;
  userIdent?: string;
}

export interface SSETokenEvent {
  type: 'token';
  content: string;
}

export interface SSEIntentEvent {
  type: 'intent';
  content: IntentCategory;
  confidence: number;
}

export interface SSEFaqEvent {
  type: 'faq';
  content: Array<{
    id: string;
    question: string;
    answer: string;
    similarity: number;
    source?: 'vector' | 'keyword' | 'hybrid';
    vectorScore?: number;
    keywordScore?: number;
  }>;
}

export interface SSEDoneEvent {
  type: 'done';
  content: {
    sessionId: string;
    messageId: string;
    intent: IntentCategory;
  };
}

export interface SSEErrorEvent {
  type: 'error';
  content: string;
}

export interface SSEEscalateEvent {
  type: 'escalate';
  content: string;
}

export type SSEEvent = SSETokenEvent | SSEIntentEvent | SSEFaqEvent | SSEDoneEvent | SSEErrorEvent | SSEEscalateEvent;

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

// ---- Satisfaction ----
export interface SatisfactionRequest {
  messageId?: string;
  sessionId?: string;
  rating: SatisfactionRating;
}

// ---- FAQ ----
export interface FaqSearchRequest {
  q: string;
  limit?: number;
}

export interface FaqCreateRequest {
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
  isActive?: number;
}

export interface FaqUpdateRequest extends Partial<FaqCreateRequest> {
  id: string;
}

export interface FaqImportItem {
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
}

// ---- Pagination ----
export interface PaginationRequest {
  page?: number;
  pageSize?: number;
  status?: SessionStatus;
  category?: IntentCategory;
  dateFrom?: string;
  dateTo?: string;
}

export interface PaginationResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---- Admin Stats ----
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

// ---- Conversation Detail ----
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
