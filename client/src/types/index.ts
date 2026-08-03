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

export type EscalationCategory =
  | 'account_security' | 'complaint' | 'refund' | 'order'
  | 'technical' | 'general' | 'unknown';
export type EscalationPriority = 'urgent' | 'high' | 'normal';
export type EscalationQueue =
  | 'account_security' | 'complaints' | 'after_sales' | 'order_support'
  | 'technical_support' | 'general_support' | 'manual_triage';
export type EscalationExtractionMode =
  | 'deterministic' | 'llm_json_schema' | 'llm_json_object'
  | 'llm_text' | 'legacy_unstructured';

export interface EscalationFact {
  label: string;
  value: string;
  sourceMessageId: string;
  sourceExcerpt: string;
}

export interface EscalationEvidenceSource {
  knowledgeType: 'faq' | 'document';
  knowledgeId: string;
  documentId?: string;
  title: string;
  similarity: number;
  chunkIndex?: number;
  pageStart?: number;
  pageEnd?: number;
}

export interface EscalationPacket {
  escalationId: string;
  sessionId: string;
  schemaVersion: number;
  ruleVersion: string;
  summary: string;
  category: EscalationCategory;
  priority: EscalationPriority;
  reasonCode: string;
  reason: string;
  riskFlags: string[];
  confirmedFacts: EscalationFact[];
  missingInformation: string[];
  evidenceSources: EscalationEvidenceSource[];
  recommendedQueue: EscalationQueue;
  suggestedNextStep: string;
  extractionMode: EscalationExtractionMode;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeReviewStatus = 'pending' | 'converted' | 'dismissed';
export type KnowledgeReviewTriggerReason = 'no_match' | 'low_retrieval_score' | 'negative_feedback';
export type AnswerMode = 'direct_faq' | 'grounded_generation' | 'refusal';
export type GroundingStatus = 'sufficient' | 'insufficient' | 'conflicting' | 'high_risk' | 'escalated';

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
  sourceBlockIds?: string[];
  extractionJobId?: string;
  extractionEngine?: 'paddleocr_ppstructurev3' | 'deepseek_ocr2';
  extractionEngineVersion?: string;
}

export type DocumentFormat = 'txt' | 'md' | 'pdf' | 'docx' | 'png' | 'jpeg' | 'webp';
export type DocumentStatus = 'pending' | 'ready' | 'failed';
export type DocumentQualityDecision = 'ready' | 'review_required' | 'rejected';
export type DocumentIndexStatus = 'legacy' | 'not_indexed' | 'published' | 'failed';
export type DocumentProcessingStatus = 'running' | 'succeeded' | 'failed';
export type DocumentProcessingStageStatus = 'running' | 'succeeded' | 'failed';
export type DocumentProcessingStageName =
  | 'validate'
  | 'parse'
  | 'normalize'
  | 'clean'
  | 'quality_gate'
  | 'chunk'
  | 'embed'
  | 'publish';

export interface DocumentItem {
  id: string;
  fileName: string;
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  isActive: number;
  parserVersion: string;
  chunkerVersion: string;
  failureCode: string | null;
  characterCount: number;
  chunkCount: number;
  sourceVersion?: number;
  representationVersion?: string | null;
  cleanerVersion?: string | null;
  qualityDecision?: DocumentQualityDecision | null;
  qualityReasons?: string[];
  latestTaskId?: string | null;
  latestRepresentationId?: string | null;
  indexStatus?: DocumentIndexStatus;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  characterCount: number;
  sourceBlockIds?: string[];
  headingPath?: string[];
  representationVersion?: string | null;
  chunkerVersion?: string | null;
  extractionJobId?: string | null;
  extractionEngine?: 'paddleocr_ppstructurev3' | 'deepseek_ocr2' | null;
  extractionEngineVersion?: string | null;
  createdAt: string;
}

export interface DocumentProcessingStage {
  name: DocumentProcessingStageName;
  order: number;
  status: DocumentProcessingStageStatus;
  startedAt: string;
  completedAt: string | null;
  inputCount: number | null;
  outputCount: number | null;
  errorCode: string | null;
}

export interface DocumentProcessingSummary {
  taskId: string;
  status: DocumentProcessingStatus;
  retryOf: string | null;
  representationVersion: string | null;
  parserVersion: string | null;
  cleanerVersion: string | null;
  chunkerVersion: string | null;
  qualityDecision: DocumentQualityDecision | null;
  qualityReasons: string[];
  failureCode: string | null;
  indexStatus: DocumentIndexStatus;
  startedAt: string;
  completedAt: string | null;
  inputBytes: number;
  outputCharacters: number;
  blockCount: number;
  chunkCount: number;
  stages: DocumentProcessingStage[];
}

export interface DocumentRepresentationSummary {
  id: string;
  schemaVersion: string;
  parserName: string;
  parserVersion: string;
  cleanerVersion: string;
  blockCount: number;
  warningCodes: string[];
  metrics: Record<string, number>;
  createdAt: string;
}

export interface DocumentExtractionSummary {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  role: 'authoritative' | 'shadow';
  engine: 'paddleocr_ppstructurev3' | 'deepseek_ocr2';
  engineVersion: string;
  retryOf: string | null;
  errorCode: string | null;
  blockCount: number;
  warningCodes: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DocumentDetail extends DocumentItem {
  processingSummary: DocumentProcessingSummary | null;
  representationSummary: DocumentRepresentationSummary | null;
  extractionSummary?: DocumentExtractionSummary | null;
  shadowExtractionSummary?: DocumentExtractionSummary | null;
  extractionHistory?: DocumentExtractionSummary[];
  ocrComparisonSummary?: {
    status: 'pending' | 'available' | 'failed';
    authoritativeJobId: string;
    shadowJobId: string;
    blockCountDelta: number | null;
    warningCountDelta: number | null;
    textAgreement: number | null;
    structureAgreement: number | null;
  } | null;
  reviewDraftSummary?: {
    id: string;
    revision: number;
    status: 'open' | 'published' | 'superseded';
    blockCount: number;
    manuallyEditedBlockCount: number;
    updatedBy: string;
    updatedAt: string;
    publishedAt: string | null;
  } | null;
}

export type DocumentBlockKind =
  | 'text'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'key_value'
  | 'image_ref';

export interface DocumentBlock {
  id: string;
  order: number;
  kind: DocumentBlockKind;
  pageNumber: number | null;
  headingPath: string[];
  confidence: number | null;
  layout?: { x: number; y: number; width: number; height: number } | null;
  excluded: boolean;
  exclusionReason: string | null;
  manuallyEdited?: boolean;
  text?: string;
  variant?: 'plain' | 'code';
  level?: number;
  ordered?: boolean;
  items?: Array<{ ordinal: number; text: string }>;
  rowCount?: number;
  columnCount?: number;
  cells?: Array<{
    rowIndex: number;
    columnIndex: number;
    rowSpan: number;
    columnSpan: number;
    text: string;
    isHeader: boolean;
  }>;
  pairs?: Array<{ key: string; value: string }>;
  altText?: string | null;
  relationshipId?: string | null;
  contentType?: string | null;
  requiresVisualProcessing?: true;
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

export type RerankerMode = 'none' | 'local_overlap_v1';
export type QualityRunStatus =
  | 'queued' | 'running' | 'completed' | 'failed'
  | 'interrupted' | 'cancelled' | 'stale';
export type QualityBackendTarget =
  | { provider: 'memory' }
  | { provider: 'qdrant'; indexJobId: string };

export interface RetrievalPolicyConfig {
  directFaqThreshold: number;
  generationEvidenceThreshold: number;
  sourceDiversityRatio: number;
  rerankerMode: RerankerMode;
}

export interface RetrievalPolicy {
  id: string;
  version: number;
  config: RetrievalPolicyConfig;
  sourceRunId: string | null;
  sourceCandidateKey: string | null;
  createdBy: string;
  createdAt: string;
}

export interface RetrievalPolicyEvent {
  id: string;
  action: 'activate' | 'rollback';
  fromPolicyId: string;
  toPolicyId: string;
  actor: string;
  sourceRunId: string | null;
  createdAt: string;
}

export interface QualityDatasetVersion {
  id: string;
  datasetId: string;
  name: string;
  description: string;
  origin: 'builtin' | 'custom';
  version: number;
  status: 'draft' | 'published';
  targetKind: 'fixture' | 'current';
  contentHash: string | null;
  caseCount: number;
  publishedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface QualityCase {
  id: string;
  versionId: string;
  query: string;
  expectedAnswerMode: AnswerMode;
  expectedGroundingStatus: GroundingStatus;
  expectedSources: Array<{ knowledgeType: 'faq' | 'document'; knowledgeId: string }>;
  language: 'zh' | 'en';
  tags: string[];
  createdAt: string;
}

export interface QualityMetrics {
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  decisionAccuracy: number;
  unsafeAnswerCount: number;
  overRefusalCount: number;
  sourceDistribution: Record<string, number>;
  p50LatencyMs: number;
  p95LatencyMs: number;
  failureCount: number;
  embeddingCallCount: number;
  estimatedTokenCount: number;
  estimatedCost: null;
}

export interface QualityCandidateResult {
  key: string;
  backendTarget: QualityBackendTarget;
  policy: RetrievalPolicyConfig;
  metrics: QualityMetrics;
  recommended: boolean;
  cases: Array<{
    caseId: string;
    passed: boolean;
    failureReason: string | null;
  }>;
}

export interface QualityRun {
  id: string;
  datasetVersionIds: string[];
  policies: RetrievalPolicyConfig[];
  backendTargets: QualityBackendTarget[];
  status: QualityRunStatus;
  progress: number;
  totalCases: number;
  knowledgeFingerprint: string | null;
  activePolicyId: string;
  candidates: QualityCandidateResult[];
  failureCode: string | null;
  cancelRequested: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PolicyGateResult {
  eligible: boolean;
  warnings: string[];
  reasons: string[];
}

export type RetrievalIndexJobStatus =
  | 'queued' | 'running' | 'interrupted' | 'ready'
  | 'active' | 'rolled_back' | 'failed' | 'stale';

export interface RetrievalIndexJob {
  id: string;
  status: RetrievalIndexJobStatus;
  collection: string;
  embeddingProfile: string;
  vectorDimension: number;
  knowledgeFingerprint: string;
  expectedCount: number;
  completedCount: number;
  checkpoint: number;
  previousCollection: string | null;
  failureCode: string | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  activatedAt: string | null;
  rolledBackAt: string | null;
  updatedAt: string;
}

export interface RetrievalStatus {
  provider: 'memory' | 'qdrant';
  qdrantConfigured: boolean;
  qdrantHealth: 'healthy' | 'degraded' | 'unavailable' | 'not_configured';
  alias: string;
  collection: string | null;
  points: number | null;
  dimensions: number | null;
  syncStatus: 'synced' | 'stale' | 'not_configured';
}

export interface RetrievalActivationCheck {
  eligible: boolean;
  warnings: string[];
  reasons: string[];
  qualityRunId: string | null;
  candidateKey: string | null;
}

export type RetrievalTraceStatus = 'completed' | 'degraded' | 'failed';
export type RetrievalTraceStageName =
  | 'query_expand' | 'embedding' | 'vector_recall' | 'keyword_recall'
  | 'fusion' | 'rerank' | 'context_budget' | 'grounding';

export interface RetrievalTraceCandidate {
  knowledgeType: 'faq' | 'document';
  knowledgeId: string;
  score?: number;
  rank?: number;
  source?: 'vector' | 'keyword' | 'hybrid';
}

export interface RetrievalTraceStage {
  name: RetrievalTraceStageName;
  order: number;
  status: 'completed' | 'degraded' | 'failed' | 'skipped';
  latencyMs: number;
  inputCount: number;
  outputCount: number;
  candidates: RetrievalTraceCandidate[];
  budget: Record<string, number>;
  errorCode: string | null;
}

export interface RetrievalTrace {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  policyId: string;
  backend: 'memory' | 'qdrant';
  status: RetrievalTraceStatus;
  errorCode: string | null;
  totalLatencyMs: number;
  stages: RetrievalTraceStage[];
  createdAt: string;
  completedAt: string;
}

export interface RetrievalTraceDetail {
  trace: RetrievalTrace;
  messages: {
    user: { id: string; content: string } | null;
    assistant: { id: string; content: string } | null;
  };
  knowledge: Array<{
    knowledgeType: 'faq' | 'document';
    knowledgeId: string;
    title: string;
    content: string;
    available: boolean;
  }>;
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
  fusionScore?: number;
  vectorRank?: number;
  keywordRank?: number;
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

export type ModelProvider = 'openai' | 'openai-compatible' | 'other';

export interface ModelConfigDTO {
  llmProvider: ModelProvider;
  llmApiBase: string;
  llmModel: string;
  embedProvider: ModelProvider;
  embedApiBase: string;
  embedModel: string;
}

export type EditableModelConfigDTO = Pick<
  ModelConfigDTO,
  'llmProvider' | 'llmModel' | 'embedProvider' | 'embedModel'
>;

export interface ModelConfigResponseDTO extends ModelConfigDTO {
  llmApiKeyConfigured: boolean;
  embedApiKeyConfigured: boolean;
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
  activeWindowMinutes: number;
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
    closedAt: string | null;
    closeReason: string | null;
  };
  messages: Array<{
    id: string;
    role: MessageRole;
    content: string;
    intent: IntentCategory | null;
    intentConf: number | null;
    retrievalSnapshot: KnowledgeRetrievalSnapshot[];
    answerMode: AnswerMode | null;
    groundingStatus: GroundingStatus | null;
    groundingReason: string | null;
    retrievalPolicyId: string | null;
    satisfaction: SatisfactionRating | null;
    escalated: number;
    createdAt: string;
  }>;
  escalation: {
    id: string;
    reason: string;
    status: EscalationStatus;
    createdAt: string;
    packet?: EscalationPacket;
  } | null;
}

export interface EscalationListItem {
  id: string;
  sessionId: string;
  userIdent: string;
  reason: string;
  status: EscalationStatus;
  resolvedAt: string | null;
  createdAt: string;
  packet: EscalationPacket;
}

export interface EscalationDetail {
  escalation: {
    id: string;
    sessionId: string;
    reason: string;
    status: EscalationStatus;
    resolvedAt: string | null;
    createdAt: string;
  };
  packet: EscalationPacket;
  session: {
    id: string;
    userIdent: string;
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    closeReason: string | null;
  };
  messages: ConversationDetail['messages'];
  referencedMessageIds: string[];
}

export interface ChatHistorySession {
  id: string;
  userIdent: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  messageCount: number;
  preview: string | null;
}

export type OnboardingStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'dismissed'
  | 'legacy';

export interface OnboardingOverview {
  installKind: 'fresh' | 'legacy';
  status: OnboardingStatus;
  runId: string | null;
  startedAt: string | null;
  sampleLoadedAt: string | null;
  firstAnswerAt: string | null;
  firstAnswerSessionId: string | null;
  firstAnswerMessageId: string | null;
  evidenceReviewedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  lastFailureCode: string | null;
  shouldAutoRedirect: boolean;
  recommendedQuestions: { zh: string; en: string };
  samplePack: {
    packVersion: string;
    status: 'installing' | 'ready' | 'failed';
    faqIds: string[];
    documentId: string | null;
    failureCode: string | null;
    completedAt: string | null;
  } | null;
  readiness: {
    database: 'ready';
    answerMode: 'provider_configured' | 'deterministic_local';
    externalTelemetry: false;
  };
}
