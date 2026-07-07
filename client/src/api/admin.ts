/**
 * Admin API client — authentication, conversations, FAQ, stats, and model config.
 */

import { get, post, put, del, uploadFile, downloadBlob } from './client';
import { IntentCategory } from '../types';
import type {
  LoginResponse,
  PaginationResponse,
  AdminOverview,
  SatisfactionTrend,
  IntentDistribution,
  ConversationDetail,
  FaqEntry,
  FaqIndexStatus,
  ModelConfigResponseDTO,
  ModelConfigDTO,
} from '../types';

// Re-export types
export { IntentCategory };
export type {
  LoginResponse,
  PaginationResponse,
  AdminOverview,
  SatisfactionTrend,
  IntentDistribution,
  ConversationDetail,
  FaqEntry,
  FaqIndexStatus,
  ModelConfigResponseDTO,
  ModelConfigDTO,
};

// ── Auth ───────────────────────────────────────────

export async function login(username: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/auth/login', { username, password });
}

// ── Conversations ──────────────────────────────────

export async function getConversations(params: {
  page?: number;
  limit?: number;
  intent?: string;
  from?: string;
  to?: string;
  keyword?: string;
}): Promise<PaginationResponse<unknown>> {
  return get<PaginationResponse<unknown>>('/admin/conversations', {
    page: params.page,
    limit: params.limit,
    intent: params.intent,
    from: params.from,
    to: params.to,
    keyword: params.keyword,
  });
}

export async function getConversationDetail(sessionId: string): Promise<ConversationDetail> {
  return get<ConversationDetail>(`/admin/conversations/${sessionId}`);
}

export async function exportConversations(from?: string, to?: string): Promise<void> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
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

// ── Model Config ───────────────────────────────────

/**
 * Get current effective model configuration (API keys are masked server-side).
 */
export async function getModelConfig(): Promise<ModelConfigResponseDTO> {
  return get<ModelConfigResponseDTO>('/admin/config/model');
}

/**
 * Update model configuration. Only non-empty fields are persisted.
 * Empty/omitted fields keep their current value.
 */
export async function updateModelConfig(updates: Partial<ModelConfigDTO>, resetKeys: string[] = []): Promise<void> {
  return put<void>('/admin/config/model', { ...updates, resetKeys });
}
