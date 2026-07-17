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

export enum AdminRole {
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

export enum KnowledgeReviewTriggerReason {
  NO_MATCH = 'no_match',
  LOW_RETRIEVAL_SCORE = 'low_retrieval_score',
  NEGATIVE_FEEDBACK = 'negative_feedback',
}

export enum KnowledgeReviewStatus {
  PENDING = 'pending',
  CONVERTED = 'converted',
  DISMISSED = 'dismissed',
}

export type DocumentFormat = 'txt' | 'md' | 'pdf' | 'docx';
export type DocumentStatus = 'pending' | 'ready' | 'failed';

export interface DocumentRecord {
  id: string;
  fileName: string;
  storagePath: string;
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  isActive: number;
  parserVersion: string;
  chunkerVersion: string;
  failureCode: string | null;
  characterCount: number;
  chunkCount: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type Document = Omit<DocumentRecord, 'storagePath' | 'sha256'>;

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  characterCount: number;
  embedding: number[];
  embeddingProfile: string | null;
  createdAt: string;
}

export type DocumentChunkView = Omit<DocumentChunk, 'embedding' | 'embeddingProfile'>;

export interface KnowledgeRetrievalSnapshot {
  knowledgeType: 'faq' | 'document';
  knowledgeId: string;
  documentId?: string;
  title: string;
  source?: 'vector' | 'keyword' | 'hybrid';
  similarity: number;
  keywordScore?: number;
  vectorScore?: number;
  fusionScore?: number;
  keywordRank?: number;
  vectorRank?: number;
  chunkIndex?: number;
  pageStart?: number;
  pageEnd?: number;
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

export interface Session {
  id: string;
  userIdent: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  intent: IntentCategory | null;
  intentConf: number | null;
  satisfaction: SatisfactionRating | null;
  escalated: number;
  replyToMessageId: string | null;
  retrievalSnapshot: KnowledgeRetrievalSnapshot[];
  createdAt: string;
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
  embedding: number[] | null;
  embeddingProfile: string | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  createdAt: string;
}

export interface EscalationLog {
  id: string;
  sessionId: string;
  reason: string;
  status: EscalationStatus;
  resolvedAt: string | null;
  createdAt: string;
}
