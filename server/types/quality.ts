import type { AnswerMode, GroundingStatus } from './domain';
import type { KnowledgeRetrievalSnapshot } from './domain';

export type QualityDatasetOrigin = 'builtin' | 'custom';
export type QualityDatasetStatus = 'draft' | 'published';
export type QualityTargetKind = 'fixture' | 'current';
export type QualityRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'stale';
export type RerankerMode = 'none' | 'local_overlap_v1';

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

export interface PolicyGateResult {
  eligible: boolean;
  warnings: string[];
  reasons: string[];
}

export interface QualityExpectedSource {
  knowledgeType: 'faq' | 'document';
  knowledgeId: string;
}

export interface QualityCase {
  id: string;
  versionId: string;
  query: string;
  expectedAnswerMode: AnswerMode;
  expectedGroundingStatus: GroundingStatus;
  expectedSources: QualityExpectedSource[];
  language: 'zh' | 'en';
  tags: string[];
  createdAt: string;
}

export interface QualityDatasetVersion {
  id: string;
  datasetId: string;
  name: string;
  description: string;
  origin: QualityDatasetOrigin;
  version: number;
  status: QualityDatasetStatus;
  targetKind: QualityTargetKind;
  contentHash: string | null;
  caseCount: number;
  publishedAt: string | null;
  createdBy: string;
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

export interface QualityCaseResult {
  caseId: string;
  candidateKey: string;
  actualAnswerMode: AnswerMode;
  actualGroundingStatus: GroundingStatus;
  sources: KnowledgeRetrievalSnapshot[];
  latencyMs: number;
  passed: boolean;
  failureReason: string | null;
}

export interface QualityCandidateResult {
  key: string;
  policy: RetrievalPolicyConfig;
  metrics: QualityMetrics;
  recommended: boolean;
  cases: QualityCaseResult[];
}

export interface QualityRun {
  id: string;
  datasetVersionIds: string[];
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
