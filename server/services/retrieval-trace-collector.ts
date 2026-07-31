import { v4 as uuidv4 } from 'uuid';
import {
  RETRIEVAL_TRACE_STAGES,
  RetrievalTrace,
  RetrievalTraceCandidate,
  RetrievalTraceStage,
  RetrievalTraceStageName,
  RetrievalTraceStageStatus,
} from '../types/retrieval-ops';

interface CollectorOptions {
  backend: 'memory' | 'qdrant';
  now?: () => Date;
}

interface RecordStage {
  status: RetrievalTraceStageStatus;
  latencyMs: number;
  inputCount: number;
  outputCount: number;
  candidates?: RetrievalTraceCandidate[];
  budget?: Record<string, number>;
  errorCode?: string | null;
}

export class RetrievalTraceCollector {
  readonly id = uuidv4();
  readonly backend: 'memory' | 'qdrant';
  private readonly now: () => Date;
  private readonly createdAt: string;
  private readonly startedAt: number;
  private readonly stages = new Map<RetrievalTraceStageName, RetrievalTraceStage>();
  private traceErrorCode: string | null = null;
  private forcedFailure = false;

  constructor(options: CollectorOptions) {
    this.backend = options.backend;
    this.now = options.now ?? (() => new Date());
    this.createdAt = this.now().toISOString();
    this.startedAt = performance.now();
  }

  record(name: RetrievalTraceStageName, stage: RecordStage): void {
    const candidateLimit = name === 'grounding' ? 3 : 20;
    this.stages.set(name, {
      name,
      order: RETRIEVAL_TRACE_STAGES.indexOf(name),
      status: stage.status,
      latencyMs: finiteNonNegative(stage.latencyMs),
      inputCount: boundedCount(stage.inputCount),
      outputCount: boundedCount(stage.outputCount),
      candidates: (stage.candidates ?? []).slice(0, candidateLimit).map(safeCandidate),
      budget: Object.fromEntries(Object.entries(stage.budget ?? {}).flatMap(([key, value]) => (
        Number.isFinite(value) && value >= 0 ? [[key, value]] : []
      ))),
      errorCode: safeErrorCode(stage.errorCode),
    });
    if (stage.status === 'failed') this.forcedFailure = true;
    if (stage.status === 'degraded' && !this.traceErrorCode) {
      this.traceErrorCode = safeErrorCode(stage.errorCode);
    }
  }

  fail(errorCode: string): void {
    this.forcedFailure = true;
    this.traceErrorCode = safeErrorCode(errorCode);
  }

  complete(params: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string | null;
    policyId: string;
  }): RetrievalTrace {
    const completedAt = this.now().toISOString();
    const stages = RETRIEVAL_TRACE_STAGES.map((name, order) => (
      this.stages.get(name) ?? {
        name,
        order,
        status: 'skipped' as const,
        latencyMs: 0,
        inputCount: 0,
        outputCount: 0,
        candidates: [],
        budget: {},
        errorCode: null,
      }
    ));
    const degraded = stages.some((stage) => stage.status === 'degraded');
    return {
      id: this.id,
      sessionId: params.sessionId,
      userMessageId: params.userMessageId,
      assistantMessageId: params.assistantMessageId,
      policyId: params.policyId,
      backend: this.backend,
      status: this.forcedFailure ? 'failed' : degraded ? 'degraded' : 'completed',
      errorCode: this.traceErrorCode,
      totalLatencyMs: finiteNonNegative(performance.now() - this.startedAt),
      stages,
      createdAt: this.createdAt,
      completedAt,
    };
  }
}

function safeCandidate(candidate: RetrievalTraceCandidate): RetrievalTraceCandidate {
  return {
    knowledgeType: candidate.knowledgeType,
    knowledgeId: String(candidate.knowledgeId).slice(0, 200),
    score: Number.isFinite(candidate.score) ? candidate.score : undefined,
    rank: Number.isInteger(candidate.rank) && (candidate.rank ?? 0) > 0
      ? candidate.rank
      : undefined,
    source: candidate.source,
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(3)) : 0;
}

function boundedCount(value: number): number {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function safeErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9_:-]{1,80}$/i.test(value) ? value : 'retrieval_stage_failed';
}
