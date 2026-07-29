import Database from 'better-sqlite3';
import { config } from '../config';
import { getDatabase } from '../db';
import { RetrievalTraceRepo } from '../db/repos/retrieval-trace.repo';
import type { RetrievalTrace, RetrievalTraceStatus } from '../types/retrieval-ops';
import { NotFoundError } from '../utils/errors';

interface RetrievalTraceServiceOptions {
  retentionDays?: number;
  now?: () => Date;
}

export class RetrievalTraceService {
  private readonly repo: RetrievalTraceRepo;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database.Database = getDatabase(),
    options: RetrievalTraceServiceOptions = {},
  ) {
    this.repo = new RetrievalTraceRepo(db);
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
    const messageRows = this.db.prepare(`
      SELECT id, content FROM messages
      WHERE id IN (?, ?)
    `).all(
      trace.userMessageId,
      trace.assistantMessageId ?? '',
    ) as Array<{ id: string; content: string }>;
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
    const knowledge = [
      ...this.resolveFaqs(faqIds),
      ...this.resolveDocumentChunks(documentIds),
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

  private resolveFaqs(ids: string[]): Array<{
    knowledgeType: 'faq';
    knowledgeId: string;
    title: string;
    content: string;
    available: boolean;
  }> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)].slice(0, 160);
    const rows = this.db.prepare(`
      SELECT id, question, answer FROM faq_entries
      WHERE id IN (${unique.map(() => '?').join(', ')})
    `).all(...unique) as Array<{ id: string; question: string; answer: string }>;
    return rows.map((row) => ({
      knowledgeType: 'faq',
      knowledgeId: row.id,
      title: row.question,
      content: row.answer,
      available: true,
    }));
  }

  private resolveDocumentChunks(ids: string[]): Array<{
    knowledgeType: 'document';
    knowledgeId: string;
    title: string;
    content: string;
    available: boolean;
  }> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)].slice(0, 160);
    const rows = this.db.prepare(`
      SELECT chunk.id, document.file_name, chunk.content
      FROM document_chunks chunk
      JOIN documents document ON document.id = chunk.document_id
      WHERE chunk.id IN (${unique.map(() => '?').join(', ')})
    `).all(...unique) as Array<{ id: string; file_name: string; content: string }>;
    return rows.map((row) => ({
      knowledgeType: 'document',
      knowledgeId: row.id,
      title: row.file_name,
      content: row.content,
      available: true,
    }));
  }
}

let singleton: RetrievalTraceService | null = null;

export function getRetrievalTraceService(): RetrievalTraceService {
  if (!singleton) singleton = new RetrievalTraceService();
  return singleton;
}
