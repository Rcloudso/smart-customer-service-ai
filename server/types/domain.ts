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

export type AnswerMode = 'direct_faq' | 'grounded_generation' | 'refusal';
export type GroundingStatus = 'sufficient' | 'insufficient' | 'conflicting' | 'high_risk' | 'escalated';

export type ParsedDocumentFormat = 'txt' | 'md' | 'pdf' | 'docx';
export type VisualDocumentFormat = 'png' | 'jpeg' | 'webp';
export type DocumentFormat = ParsedDocumentFormat | VisualDocumentFormat;
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
  sourceVersion: number;
  representationVersion: string | null;
  cleanerVersion: string | null;
  qualityDecision: DocumentQualityDecision | null;
  qualityReasons: string[];
  latestTaskId: string | null;
  latestRepresentationId: string | null;
  indexStatus: DocumentIndexStatus;
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
  sourceBlockIds?: string[];
  headingPath?: string[];
  representationVersion?: string | null;
  chunkerVersion?: string | null;
  createdAt: string;
}

export type DocumentChunkView = Omit<DocumentChunk, 'embedding' | 'embeddingProfile'>;

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

export interface DocumentReviewDraftSummary {
  id: string;
  revision: number;
  status: 'open' | 'published' | 'superseded';
  blockCount: number;
  manuallyEditedBlockCount: number;
  updatedBy: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface DocumentDetail extends Document {
  processingSummary: DocumentProcessingSummary | null;
  representationSummary: DocumentRepresentationSummary | null;
  extractionSummary: DocumentExtractionSummary | null;
  reviewDraftSummary: DocumentReviewDraftSummary | null;
}

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
  closeReason: string | null;
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
  answerMode: AnswerMode | null;
  groundingStatus: GroundingStatus | null;
  groundingReason: string | null;
  retrievalPolicyId: string | null;
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

export type EscalationCategory =
  | 'account_security'
  | 'complaint'
  | 'refund'
  | 'order'
  | 'technical'
  | 'general'
  | 'unknown';
export type EscalationPriority = 'urgent' | 'high' | 'normal';
export type EscalationQueue =
  | 'account_security'
  | 'complaints'
  | 'after_sales'
  | 'order_support'
  | 'technical_support'
  | 'general_support'
  | 'manual_triage';
export type EscalationReasonCode =
  | 'account_security'
  | 'unauthorized_transaction'
  | 'safety_risk'
  | 'complaint'
  | 'knowledge_conflict'
  | 'unsupported_business_action'
  | 'user_requested_human'
  | 'frustration'
  | 'low_confidence_or_coverage_gap'
  | 'model_requested_escalation'
  | 'legacy_unstructured';
export type EscalationRiskFlag =
  | 'account_security'
  | 'unauthorized_transaction'
  | 'safety_risk'
  | 'private_data_required'
  | 'business_action_required'
  | 'knowledge_conflict'
  | 'complaint'
  | 'low_confidence';
export type EscalationExtractionMode =
  | 'deterministic'
  | 'llm_json_schema'
  | 'llm_json_object'
  | 'llm_text'
  | 'legacy_unstructured';

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
  reasonCode: EscalationReasonCode;
  reason: string;
  riskFlags: EscalationRiskFlag[];
  confirmedFacts: EscalationFact[];
  missingInformation: string[];
  evidenceSources: EscalationEvidenceSource[];
  recommendedQueue: EscalationQueue;
  suggestedNextStep: string;
  extractionMode: EscalationExtractionMode;
  createdAt: string;
  updatedAt: string;
}
