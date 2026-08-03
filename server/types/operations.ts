export type OperationHealth = 'healthy' | 'configured' | 'optional_disabled' | 'degraded' | 'failed';

export interface OperationServiceStatus {
  key: 'sqlite' | 'answer' | 'embedding' | 'qdrant' | 'ocr';
  health: OperationHealth;
  mode: string;
  detail: string;
  ownerPath: string;
}

export interface OperationTaskCounts {
  queued: number;
  running: number;
  failed: number;
}

export interface OperationProblem {
  id: string;
  kind: 'document' | 'quality' | 'index' | 'trace' | 'ocr';
  title: string;
  status: string;
  failureCode: string | null;
  occurredAt: string;
  ownerPath: string;
  recovery: 'retry_document' | 'rerun_quality' | null;
}

export interface OperationsOverview {
  generatedAt: string;
  services: OperationServiceStatus[];
  tasks: {
    total: OperationTaskCounts;
    documents: OperationTaskCounts;
    quality: OperationTaskCounts;
    indexes: OperationTaskCounts;
    ocr: OperationTaskCounts;
  };
  recentProblems: OperationProblem[];
  limits: { recentProblems: number };
}
