import Database from 'better-sqlite3';
import { config } from '../config';
import { getDatabase } from '../db';
import { RetrievalTraceRepo } from '../db/repos/retrieval-trace.repo';
import { RetrievalTraceDetailRepo } from '../db/repos/retrieval-trace-detail.repo';
import type { RetrievalTrace, RetrievalTraceStatus } from '../types/retrieval-ops';
import { NotFoundError } from '../utils/errors';

interface RetrievalTraceServiceOptions {
  retentionDays?: number;
  now?: () => Date;
}

export class RetrievalTraceService {
  private readonly repo: RetrievalTraceRepo;
  private readonly detailRepo: RetrievalTraceDetailRepo;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    db: Database.Database = getDatabase(),
    options: RetrievalTraceServiceOptions = {},
  ) {
    this.repo = new RetrievalTraceRepo(db);
    this.detailRepo = new RetrievalTraceDetailRepo(db);
    this.retentionDays = options.retentionDays ?? config.vectorStore.traceRetentionDays;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.cleanupExpired();
    if (this.timer) return;
    this.timer = setInterval(() => this.cleanupExpired(), 24 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  persist(trace: RetrievalTrace): void {
    this.repo.create(trace);
  }

  getTrace(id: string): RetrievalTrace {
    const trace = this.repo.get(id);
    if (!trace) throw new NotFoundError('Retrieval trace not found');
    return trace;
  }

  getTraceDetail(id: string): {
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
  } {
    const trace = this.getTrace(id);
    const messageRows = this.detailRepo.findMessages([
      trace.userMessageId,
      trace.assistantMessageId ?? '',
    ]);
    const byMessageId = new Map(messageRows.map((row) => [row.id, row]));
    const candidateKeys = new Map<string, { knowledgeType: 'faq' | 'document'; id: string }>();
    for (const stage of trace.stages) {
      for (const candidate of stage.candidates) {
        candidateKeys.set(
          `${candidate.knowledgeType}:${candidate.knowledgeId}`,
          { knowledgeType: candidate.knowledgeType, id: candidate.knowledgeId },
        );
      }
    }
    const faqIds = [...candidateKeys.values()]
      .filter((item) => item.knowledgeType === 'faq')
      .map((item) => item.id);
    const documentIds = [...candidateKeys.values()]
      .filter((item) => item.knowledgeType === 'document')
      .map((item) => item.id);
    const knowledge: Array<{
      knowledgeType: 'faq' | 'document';
      knowledgeId: string;
      title: string;
      content: string;
      available: boolean;
    }> = [
      ...this.detailRepo.findFaqs(faqIds),
      ...this.detailRepo.findDocumentChunks(documentIds),
    ];
    const resolved = new Set(knowledge.map((item) => (
      `${item.knowledgeType}:${item.knowledgeId}`
    )));
    for (const [key, candidate] of candidateKeys) {
      if (resolved.has(key)) continue;
      knowledge.push({
        knowledgeType: candidate.knowledgeType,
        knowledgeId: candidate.id,
        title: '',
        content: '',
        available: false,
      });
    }
    return {
      trace,
      messages: {
        user: byMessageId.get(trace.userMessageId) ?? null,
        assistant: trace.assistantMessageId
          ? byMessageId.get(trace.assistantMessageId) ?? null
          : null,
      },
      knowledge,
    };
  }

  listTraces(params: {
    page: number;
    pageSize: number;
    status?: RetrievalTraceStatus;
    backend?: 'memory' | 'qdrant';
    sessionId?: string;
    createdFrom?: string;
    createdTo?: string;
  }): { items: RetrievalTrace[]; total: number; page: number; pageSize: number } {
    const result = this.repo.list({
      ...params,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });
    return { ...result, page: params.page, pageSize: params.pageSize };
  }

  cleanupExpired(): number {
    const cutoff = new Date(
      this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.repo.deleteBefore(cutoff);
  }
}

let singleton: RetrievalTraceService | null = null;

export function getRetrievalTraceService(): RetrievalTraceService {
  if (!singleton) singleton = new RetrievalTraceService();
  return singleton;
}
