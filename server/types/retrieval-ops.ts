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
