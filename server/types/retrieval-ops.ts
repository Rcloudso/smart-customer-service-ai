export type RetrievalIndexJobStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'ready'
  | 'active'
  | 'rolled_back'
  | 'failed'
  | 'stale';

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

export interface RetrievalActivationCheck {
  eligible: boolean;
  warnings: string[];
  reasons: string[];
  qualityRunId: string | null;
  candidateKey: string | null;
}

export const RETRIEVAL_TRACE_STAGES = [
  'query_expand',
  'embedding',
  'vector_recall',
  'keyword_recall',
  'fusion',
  'rerank',
  'context_budget',
  'grounding',
] as const;

export type RetrievalTraceStageName = (typeof RETRIEVAL_TRACE_STAGES)[number];
export type RetrievalTraceStatus = 'completed' | 'degraded' | 'failed';
export type RetrievalTraceStageStatus =
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'skipped';

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
  status: RetrievalTraceStageStatus;
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
