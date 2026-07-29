import Database from 'better-sqlite3';
import {
  RetrievalTrace,
  RetrievalTraceCandidate,
  RetrievalTraceStage,
  RetrievalTraceStageName,
  RetrievalTraceStageStatus,
  RetrievalTraceStatus,
} from '../../types/retrieval-ops';

interface TraceRow {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  policy_id: string;
  backend: 'memory' | 'qdrant';
  status: RetrievalTraceStatus;
  error_code: string | null;
  total_latency_ms: number;
  created_at: string;
  completed_at: string;
}

interface StageRow {
  stage_name: RetrievalTraceStageName;
  stage_order: number;
  status: RetrievalTraceStageStatus;
  latency_ms: number;
  input_count: number;
  output_count: number;
  candidates: string;
  budget: string;
  error_code: string | null;
}

export class RetrievalTraceRepo {
  constructor(private readonly db: Database.Database) {}

  create(trace: RetrievalTrace): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO retrieval_traces (
          id, session_id, user_message_id, assistant_message_id, policy_id,
          backend, status, error_code, total_latency_ms, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trace.id,
        trace.sessionId,
        trace.userMessageId,
        trace.assistantMessageId,
        trace.policyId,
        trace.backend,
        trace.status,
        trace.errorCode,
        trace.totalLatencyMs,
        trace.createdAt,
        trace.completedAt,
      );
      const insertStage = this.db.prepare(`
        INSERT INTO retrieval_trace_stages (
          trace_id, stage_name, stage_order, status, latency_ms, input_count,
          output_count, candidates, budget, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const stage of trace.stages) {
        insertStage.run(
          trace.id,
          stage.name,
          stage.order,
          stage.status,
          stage.latencyMs,
          stage.inputCount,
          stage.outputCount,
          JSON.stringify(stage.candidates),
          JSON.stringify(stage.budget),
          stage.errorCode,
        );
      }
    })();
  }

  get(id: string): RetrievalTrace | null {
    const row = this.db.prepare(
      'SELECT * FROM retrieval_traces WHERE id = ?',
    ).get(id) as TraceRow | undefined;
    if (!row) return null;
    const stages = this.db.prepare(`
      SELECT * FROM retrieval_trace_stages
      WHERE trace_id = ? ORDER BY stage_order
    `).all(id) as StageRow[];
    return this.map(row, stages);
  }

  list(filters: {
    status?: RetrievalTraceStatus;
    backend?: 'memory' | 'qdrant';
    sessionId?: string;
    createdFrom?: string;
    createdTo?: string;
    limit: number;
    offset: number;
  }): { items: RetrievalTrace[]; total: number } {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.status) {
      clauses.push('status = ?');
      values.push(filters.status);
    }
    if (filters.backend) {
      clauses.push('backend = ?');
      values.push(filters.backend);
    }
    if (filters.sessionId) {
      clauses.push('session_id = ?');
      values.push(filters.sessionId);
    }
    if (filters.createdFrom) {
      clauses.push('created_at >= ?');
      values.push(filters.createdFrom);
    }
    if (filters.createdTo) {
      clauses.push('created_at <= ?');
      values.push(filters.createdTo);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM retrieval_traces ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...values, filters.limit, filters.offset) as TraceRow[];
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM retrieval_traces ${where}`,
    ).get(...values) as { total: number }).total;
    return {
      items: rows.map((row) => this.map(row, [])),
      total,
    };
  }

  deleteBefore(cutoff: string): number {
    return this.db.prepare(
      'DELETE FROM retrieval_traces WHERE created_at < ?',
    ).run(cutoff).changes;
  }

  private map(row: TraceRow, stages: StageRow[]): RetrievalTrace {
    return {
      id: row.id,
      sessionId: row.session_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      policyId: row.policy_id,
      backend: row.backend,
      status: row.status,
      errorCode: row.error_code,
      totalLatencyMs: row.total_latency_ms,
      stages: stages.map((stage): RetrievalTraceStage => ({
        name: stage.stage_name,
        order: stage.stage_order,
        status: stage.status,
        latencyMs: stage.latency_ms,
        inputCount: stage.input_count,
        outputCount: stage.output_count,
        candidates: parseJson<RetrievalTraceCandidate[]>(stage.candidates, []).slice(0, 20),
        budget: parseJson<Record<string, number>>(stage.budget, {}),
        errorCode: stage.error_code,
      })),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
