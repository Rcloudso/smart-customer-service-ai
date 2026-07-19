/**
 * Admin API client — authentication, conversations, FAQ, stats, and model config.
 */

import { get, post, put, del, uploadFile, downloadBlob } from './client';
import { IntentCategory, SessionStatus } from '../types';
import type {
  LoginResponse,
  PaginationResponse,
  AdminOverview,
  SatisfactionTrend,
  IntentDistribution,
  ConversationDetail,
  FaqEntry,
  FaqDebugResult,
  FaqIndexStatus,
  ModelConfigResponseDTO,
  ModelConfigDTO,
  KnowledgeReviewItem,
  KnowledgeReviewStats,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  DocumentItem,
  DocumentChunk,
  DocumentStatus,
} from '../types';

// Re-export types
export { IntentCategory, SessionStatus };
export type {
  LoginResponse,
  PaginationResponse,
  AdminOverview,
  SatisfactionTrend,
  IntentDistribution,
  ConversationDetail,
  FaqEntry,
  FaqDebugResult,
  FaqIndexStatus,
  ModelConfigResponseDTO,
  ModelConfigDTO,
  KnowledgeReviewItem,
  KnowledgeReviewStats,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  DocumentItem,
  DocumentChunk,
  DocumentStatus,
};

// ── Auth ───────────────────────────────────────────

export async function login(username: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/auth/login', { username, password }, { auth: false });
}

// ── Conversations ──────────────────────────────────

export async function getConversations(params: {
  page?: number;
  limit?: number;
  intent?: string;
  status?: SessionStatus;
  from?: string;
  to?: string;
  keyword?: string;
  timezoneOffset?: number;
  timezoneOffsetTo?: number;
}): Promise<PaginationResponse<unknown>> {
  return get<PaginationResponse<unknown>>('/admin/conversations', {
    page: params.page,
    limit: params.limit,
    intent: params.intent,
    status: params.status,
    from: params.from,
    to: params.to,
    keyword: params.keyword,
    timezoneOffset: params.timezoneOffset,
    timezoneOffsetTo: params.timezoneOffsetTo,
  });
}

export async function getConversationDetail(sessionId: string): Promise<ConversationDetail> {
  return get<ConversationDetail>(`/admin/conversations/${sessionId}`);
}

export async function exportConversations(filters?: {
  from?: string;
  to?: string;
  intent?: string;
  status?: SessionStatus;
  keyword?: string;
  timezoneOffset?: number;
  timezoneOffsetTo?: number;
}): Promise<void> {
  const params = new URLSearchParams();
  if (filters?.from) params.set('from', filters.from);
  if (filters?.to) params.set('to', filters.to);
  if (filters?.intent) params.set('intent', filters.intent);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.keyword) params.set('keyword', filters.keyword);
  if (filters?.timezoneOffset !== undefined) {
    params.set('timezoneOffset', String(filters.timezoneOffset));
  }
  if (filters?.timezoneOffsetTo !== undefined) {
    params.set('timezoneOffsetTo', String(filters.timezoneOffsetTo));
  }
  const queryStr = params.toString();
  const path = queryStr ? `/admin/conversations/export?${queryStr}` : '/admin/conversations/export';
  await downloadBlob(path, `conversations-${new Date().toISOString().slice(0, 10)}.csv`);
}

// ── Stats ──────────────────────────────────────────

export async function getStatsOverview(from?: string, to?: string): Promise<AdminOverview & { intentDistribution: IntentDistribution[] }> {
  return get<AdminOverview & { intentDistribution: IntentDistribution[] }>('/admin/stats/overview', { from, to });
}

export async function getSatisfactionTrend(from?: string, to?: string, granularity: string = 'day'): Promise<SatisfactionTrend[]> {
  return get<SatisfactionTrend[]>('/admin/stats/satisfaction-trend', { from, to, granularity });
}

// ── FAQ Management ─────────────────────────────────

export async function listFaq(params?: {
  category?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginationResponse<FaqEntry>> {
  return get<PaginationResponse<FaqEntry>>('/admin/faq', {
    category: params?.category,
    keyword: params?.keyword,
    page: params?.page,
    pageSize: params?.pageSize,
  });
}

export async function createFaq(data: {
  question: string;
  answer: string;
  category: string;
  keywords: string[];
}): Promise<FaqEntry> {
  return post<FaqEntry>('/admin/faq', data);
}

export async function updateFaq(id: string, data: {
  question?: string;
  answer?: string;
  category?: string;
  keywords?: string[];
  isActive?: number;
}): Promise<FaqEntry> {
  return put<FaqEntry>(`/admin/faq/${id}`, data);
}

export async function deleteFaq(id: string): Promise<void> {
  return del<void>(`/admin/faq/${id}`);
}

export async function importFaq(file: File): Promise<{ imported: number; total: number }> {
  return uploadFile<{ imported: number; total: number }>('/admin/faq/import', file);
}

export async function exportFaq(): Promise<void> {
  await downloadBlob('/admin/faq/export', `faq-export-${new Date().toISOString().slice(0, 10)}.csv`);
}

export async function getFaqIndexStatus(): Promise<FaqIndexStatus> {
  return get<FaqIndexStatus>('/admin/faq/index/status');
}

export async function rebuildFaqIndex(): Promise<FaqIndexStatus> {
  return post<FaqIndexStatus>('/admin/faq/index/rebuild', {});
}

export async function debugFaqSearch(data: { query: string; topK?: number }): Promise<FaqDebugResult> {
  return post<FaqDebugResult>('/admin/faq/search/debug', data);
}

// ── Knowledge Review ───────────────────────────────

export async function listKnowledgeReviews(params?: {
  status?: KnowledgeReviewStatus;
  triggerReason?: KnowledgeReviewTriggerReason;
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginationResponse<KnowledgeReviewItem>> {
  return get<PaginationResponse<KnowledgeReviewItem>>('/admin/knowledge-reviews', params);
}

export async function getKnowledgeReviewStats(): Promise<KnowledgeReviewStats> {
  return get<KnowledgeReviewStats>('/admin/knowledge-reviews/stats');
}

export async function convertKnowledgeReview(id: string, data: {
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
}): Promise<{ review: KnowledgeReviewItem; faq: FaqEntry }> {
  return post<{ review: KnowledgeReviewItem; faq: FaqEntry }>(`/admin/knowledge-reviews/${id}/convert`, data);
}

export async function dismissKnowledgeReview(id: string, reason?: string): Promise<KnowledgeReviewItem> {
  return post<KnowledgeReviewItem>(`/admin/knowledge-reviews/${id}/dismiss`, { reason });
}

// ── Document Knowledge ────────────────────────────

export async function listDocuments(params?: {
  status?: DocumentStatus;
  isActive?: boolean;
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginationResponse<DocumentItem>> {
  return get<PaginationResponse<DocumentItem>>('/admin/documents', {
    status: params?.status,
    isActive: params?.isActive === undefined ? undefined : String(params.isActive),
    keyword: params?.keyword,
    page: params?.page,
    pageSize: params?.pageSize,
  });
}

export async function uploadDocument(file: File): Promise<DocumentItem> {
  return uploadFile<DocumentItem>('/admin/documents', file);
}

export async function getDocument(id: string): Promise<DocumentItem> {
  return get<DocumentItem>(`/admin/documents/${id}`);
}

export async function listDocumentChunks(id: string, page: number, pageSize: number): Promise<PaginationResponse<DocumentChunk>> {
  return get<PaginationResponse<DocumentChunk>>(`/admin/documents/${id}/chunks`, { page, pageSize });
}

export async function updateDocument(id: string, isActive: boolean): Promise<DocumentItem> {
  return put<DocumentItem>(`/admin/documents/${id}`, { isActive });
}

export async function retryDocument(id: string): Promise<DocumentItem> {
  return post<DocumentItem>(`/admin/documents/${id}/retry`, {});
}

export async function deleteDocument(id: string): Promise<void> {
  return del<void>(`/admin/documents/${id}`);
}

// ── Model Config ───────────────────────────────────

/** Get non-secret model configuration and environment credential status. */
export async function getModelConfig(): Promise<ModelConfigResponseDTO> {
  return get<ModelConfigResponseDTO>('/admin/config/model');
}

/**
 * Update non-secret model configuration. Only non-empty fields are persisted.
 * Empty/omitted fields keep their current value.
 */
export async function updateModelConfig(updates: Partial<ModelConfigDTO>, resetKeys: string[] = []): Promise<void> {
  return put<void>('/admin/config/model', { ...updates, resetKeys });
}
