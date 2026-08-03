/**
 * Admin API client — authentication, conversations, FAQ, stats, and model config.
 */

import {
  createIdempotencyKey,
  get,
  post,
  put,
  del,
  uploadFile,
  downloadBlob,
} from './client';
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
  EditableModelConfigDTO,
  KnowledgeReviewItem,
  KnowledgeReviewStats,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  DocumentItem,
  DocumentDetail,
  DocumentBlock,
  DocumentChunk,
  DocumentStatus,
  DocumentQualityDecision,
  PolicyGateResult,
  QualityCase,
  QualityDatasetVersion,
  QualityRun,
  QualityBackendTarget,
  RetrievalActivationCheck,
  RetrievalIndexJob,
  RetrievalStatus,
  RetrievalTrace,
  RetrievalTraceDetail,
  RetrievalTraceStatus,
  RetrievalPolicy,
  RetrievalPolicyEvent,
  RetrievalPolicyConfig,
  EscalationCategory,
  EscalationPriority,
  EscalationQueue,
  EscalationStatus,
  EscalationListItem,
  EscalationDetail,
  OnboardingOverview,
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
  EditableModelConfigDTO,
  KnowledgeReviewItem,
  KnowledgeReviewStats,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  DocumentItem,
  DocumentDetail,
  DocumentBlock,
  DocumentChunk,
  DocumentStatus,
  DocumentQualityDecision,
  PolicyGateResult,
  QualityCase,
  QualityDatasetVersion,
  QualityRun,
  RetrievalActivationCheck,
  RetrievalIndexJob,
  RetrievalStatus,
  RetrievalTrace,
  RetrievalTraceDetail,
  RetrievalTraceStatus,
  RetrievalPolicy,
  RetrievalPolicyEvent,
  RetrievalPolicyConfig,
  EscalationCategory,
  EscalationPriority,
  EscalationQueue,
  EscalationStatus,
  EscalationListItem,
  EscalationDetail,
  OnboardingOverview,
};

function idempotentRequest(): { idempotencyKey: string } {
  return { idempotencyKey: createIdempotencyKey() };
}

// ── Auth ───────────────────────────────────────────

export async function login(username: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/auth/login', { username, password }, { auth: false });
}

// ── First value onboarding ─────────────────────────

export async function getOnboarding(): Promise<OnboardingOverview> {
  return get<OnboardingOverview>('/admin/onboarding');
}

export async function startOnboarding(): Promise<OnboardingOverview> {
  return post<OnboardingOverview>('/admin/onboarding/start', {});
}

export async function installSamplePack(): Promise<OnboardingOverview> {
  return post<OnboardingOverview>('/admin/onboarding/sample-pack', {}, idempotentRequest());
}

export async function recordGuidedAnswer(data: {
  sessionId: string;
  messageId: string;
}): Promise<OnboardingOverview> {
  return post<OnboardingOverview>('/admin/onboarding/guided-answer', data, idempotentRequest());
}

export async function completeEvidenceReview(messageId: string): Promise<OnboardingOverview> {
  return post<OnboardingOverview>('/admin/onboarding/evidence-reviewed', { messageId }, idempotentRequest());
}

export async function dismissOnboarding(): Promise<OnboardingOverview> {
  return post<OnboardingOverview>('/admin/onboarding/dismiss', {}, idempotentRequest());
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

export async function listEscalations(params?: {
  status?: EscalationStatus;
  category?: EscalationCategory;
  priority?: EscalationPriority;
  queue?: EscalationQueue;
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginationResponse<EscalationListItem>> {
  return get<PaginationResponse<EscalationListItem>>('/admin/escalations', params);
}

export async function getEscalationDetail(escalationId: string): Promise<EscalationDetail> {
  return get<EscalationDetail>(`/admin/escalations/${escalationId}`);
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
  return post<FaqEntry>('/admin/faq', data, idempotentRequest());
}

export async function updateFaq(id: string, data: {
  question?: string;
  answer?: string;
  category?: string;
  keywords?: string[];
  isActive?: number;
}): Promise<FaqEntry> {
  return put<FaqEntry>(`/admin/faq/${id}`, data, idempotentRequest());
}

export async function deleteFaq(id: string): Promise<void> {
  return del<void>(`/admin/faq/${id}`, idempotentRequest());
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
  return post<FaqIndexStatus>('/admin/faq/index/rebuild', {}, idempotentRequest());
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
  return post<{ review: KnowledgeReviewItem; faq: FaqEntry }>(
    `/admin/knowledge-reviews/${id}/convert`,
    data,
    idempotentRequest(),
  );
}

export async function dismissKnowledgeReview(id: string, reason?: string): Promise<KnowledgeReviewItem> {
  return post<KnowledgeReviewItem>(
    `/admin/knowledge-reviews/${id}/dismiss`,
    { reason },
    idempotentRequest(),
  );
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

export async function getDocument(id: string): Promise<DocumentDetail> {
  return get<DocumentDetail>(`/admin/documents/${id}`);
}

export async function listDocumentChunks(id: string, page: number, pageSize: number): Promise<PaginationResponse<DocumentChunk>> {
  return get<PaginationResponse<DocumentChunk>>(`/admin/documents/${id}/chunks`, { page, pageSize });
}

export async function listDocumentBlocks(id: string, page: number, pageSize: number): Promise<PaginationResponse<DocumentBlock>> {
  return get<PaginationResponse<DocumentBlock>>(`/admin/documents/${id}/blocks`, { page, pageSize });
}

export async function listDocumentReviewDraftBlocks(
  id: string,
  page: number,
  pageSize: number,
): Promise<PaginationResponse<DocumentBlock> & {
  draftId: string | null;
  revision: number | null;
  status: 'open' | 'published' | 'superseded' | null;
}> {
  return get(`/admin/documents/${id}/review-draft`, { page, pageSize });
}

export async function updateDocumentReviewDraft(
  id: string,
  expectedRevision: number,
  blocks: DocumentBlock[],
): Promise<{
  draftId: string;
  revision: number;
  status: 'open' | 'published' | 'superseded';
  items: DocumentBlock[];
  total: number;
}> {
  return put(
    `/admin/documents/${id}/review-draft`,
    { expectedRevision, blocks },
    idempotentRequest(),
  );
}

export async function publishDocumentReviewDraft(
  id: string,
  expectedRevision: number,
): Promise<DocumentDetail> {
  return post<DocumentDetail>(
    `/admin/documents/${id}/review-draft/publish`,
    { expectedRevision },
    idempotentRequest(),
  );
}

export async function updateDocument(id: string, isActive: boolean): Promise<DocumentItem> {
  return put<DocumentItem>(
    `/admin/documents/${id}`,
    { isActive },
    idempotentRequest(),
  );
}

export async function retryDocument(id: string): Promise<DocumentItem> {
  return post<DocumentItem>(
    `/admin/documents/${id}/retry`,
    {},
    idempotentRequest(),
  );
}

export async function reprocessDocument(id: string): Promise<DocumentItem> {
  return post<DocumentItem>(
    `/admin/documents/${id}/reprocess`,
    {},
    idempotentRequest(),
  );
}

export async function deleteDocument(id: string): Promise<void> {
  return del<void>(`/admin/documents/${id}`, idempotentRequest());
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
export async function updateModelConfig(
  updates: Partial<EditableModelConfigDTO>,
  resetKeys: Array<keyof EditableModelConfigDTO> = [],
): Promise<void> {
  return put<void>(
    '/admin/config/model',
    { ...updates, resetKeys },
    idempotentRequest(),
  );
}

// ── RAG Quality Lab ───────────────────────────────

export async function listQualityDatasets(): Promise<QualityDatasetVersion[]> {
  return get<QualityDatasetVersion[]>('/admin/quality/datasets');
}

export async function createQualityDataset(data: {
  name: string;
  description?: string;
}): Promise<QualityDatasetVersion> {
  return post('/admin/quality/datasets', data, idempotentRequest());
}

export async function listQualityCases(versionId: string): Promise<QualityCase[]> {
  return get(`/admin/quality/datasets/versions/${versionId}/cases`);
}

export async function saveQualityCase(
  versionId: string,
  data: Omit<QualityCase, 'id' | 'versionId' | 'createdAt'> & { id?: string },
): Promise<QualityCase> {
  return put(`/admin/quality/datasets/versions/${versionId}/cases`, data, idempotentRequest());
}

export async function importQualityCases(
  versionId: string,
  cases: Array<Omit<QualityCase, 'id' | 'versionId' | 'createdAt'>>,
): Promise<QualityCase[]> {
  return post(`/admin/quality/datasets/versions/${versionId}/import`, { cases }, idempotentRequest());
}

export async function publishQualityVersion(versionId: string): Promise<QualityDatasetVersion> {
  return post(`/admin/quality/datasets/versions/${versionId}/publish`, {}, idempotentRequest());
}

export async function deriveQualityVersion(versionId: string): Promise<QualityDatasetVersion> {
  return post(`/admin/quality/datasets/versions/${versionId}/derive`, {}, idempotentRequest());
}

export async function listQualityRuns(): Promise<PaginationResponse<QualityRun>> {
  return get('/admin/quality/runs', { page: 1, pageSize: 50 });
}

export async function getQualityRun(runId: string): Promise<QualityRun> {
  return get(`/admin/quality/runs/${runId}`);
}

export async function createQualityRun(data: {
  datasetVersionIds: string[];
  policies: RetrievalPolicyConfig[];
  backendTargets?: QualityBackendTarget[];
}): Promise<QualityRun> {
  return post('/admin/quality/runs', data, idempotentRequest());
}

export async function cancelQualityRun(runId: string): Promise<QualityRun> {
  return post(`/admin/quality/runs/${runId}/cancel`, {}, idempotentRequest());
}

export async function getQualityPolicies(): Promise<{
  current: RetrievalPolicy;
  history: RetrievalPolicy[];
  events: RetrievalPolicyEvent[];
}> {
  return get('/admin/quality/policies');
}

export async function checkQualityPromotion(
  runId: string,
  candidateKey: string,
): Promise<PolicyGateResult> {
  return get('/admin/quality/policies/promotion-check', { runId, candidateKey });
}

export async function activateQualityPolicy(data: {
  runId: string;
  candidateKey: string;
  expectedCurrentPolicyId: string;
  confirmed: true;
}): Promise<RetrievalPolicy> {
  return post('/admin/quality/policies/activate', data, idempotentRequest());
}

export async function rollbackQualityPolicy(data: {
  targetPolicyId: string;
  expectedCurrentPolicyId: string;
  confirmed: true;
}): Promise<RetrievalPolicy> {
  return post('/admin/quality/policies/rollback', data, idempotentRequest());
}

// ── Retrieval Operations ──────────────────────────

export async function getRetrievalStatus(): Promise<RetrievalStatus> {
  return get('/admin/retrieval/status');
}

export async function listRetrievalIndexJobs(
  page: number = 1,
  pageSize: number = 50,
): Promise<PaginationResponse<RetrievalIndexJob>> {
  return get('/admin/retrieval/index-jobs', { page, pageSize });
}

export async function createRetrievalIndexJob(): Promise<RetrievalIndexJob> {
  return post('/admin/retrieval/index-jobs', {}, idempotentRequest());
}

export async function getRetrievalActivationCheck(
  id: string,
): Promise<RetrievalActivationCheck> {
  return get(`/admin/retrieval/index-jobs/${id}/activation-check`);
}

export async function activateRetrievalIndexJob(data: {
  id: string;
  expectedCurrentCollection: string | null;
  confirmLatencyWarning: boolean;
}): Promise<RetrievalIndexJob> {
  return post(
    `/admin/retrieval/index-jobs/${data.id}/activate`,
    {
      expectedCurrentCollection: data.expectedCurrentCollection,
      confirmed: true,
      confirmLatencyWarning: data.confirmLatencyWarning,
    },
    idempotentRequest(),
  );
}

export async function rollbackRetrievalIndexJob(data: {
  id: string;
  expectedCurrentCollection: string;
}): Promise<RetrievalIndexJob> {
  return post(
    `/admin/retrieval/index-jobs/${data.id}/rollback`,
    {
      expectedCurrentCollection: data.expectedCurrentCollection,
      confirmed: true,
    },
    idempotentRequest(),
  );
}

export async function listRetrievalTraces(params?: {
  page?: number;
  pageSize?: number;
  status?: RetrievalTraceStatus;
  backend?: 'memory' | 'qdrant';
  sessionId?: string;
  createdFrom?: string;
  createdTo?: string;
}): Promise<PaginationResponse<RetrievalTrace>> {
  return get('/admin/retrieval/traces', params);
}

export async function getRetrievalTrace(
  traceId: string,
): Promise<RetrievalTraceDetail> {
  return get(`/admin/retrieval/traces/${traceId}`);
}
