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
  createdAt: string;
}

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
