import Database from 'better-sqlite3';
import type { OperationProblem, OperationTaskCounts } from '../../types/operations';

const EMPTY_COUNTS: OperationTaskCounts = { queued: 0, running: 0, failed: 0 };

export class OperationsRepo {
  constructor(private readonly db: Database.Database) {}

  taskCounts() {
    const documents = this.countStatuses('document_processing_tasks', {
      queued: [], running: ['running'], failed: ['failed'],
    });
    const quality = this.countStatuses('quality_runs', {
      queued: ['queued'], running: ['running'], failed: ['failed', 'interrupted'],
    });
    const indexes = this.countStatuses('retrieval_index_jobs', {
      queued: ['queued', 'interrupted'], running: ['running'], failed: ['failed'],
    });
    const ocr = this.countStatuses('document_extraction_jobs', {
      queued: ['queued'], running: ['running'], failed: ['failed'],
    });
    const total = [documents, quality, indexes, ocr].reduce(
      (sum, item) => ({
        queued: sum.queued + item.queued,
        running: sum.running + item.running,
        failed: sum.failed + item.failed,
      }),
      { ...EMPTY_COUNTS },
    );
    return { total, documents, quality, indexes, ocr };
  }

  recentProblems(limit: number): OperationProblem[] {
    const bounded = Math.max(1, Math.min(limit, 20));
    const rows = this.db.prepare(`
      SELECT id, kind, title, status, failure_code, occurred_at, owner_path, recovery
      FROM (
        SELECT id, 'document' AS kind, file_name AS title, status, failure_code,
               updated_at AS occurred_at, '/admin/documents' AS owner_path,
               'retry_document' AS recovery
        FROM documents WHERE status = 'failed'
        UNION ALL
        SELECT id, 'quality', 'Quality run ' || substr(id, 1, 8), status, failure_code,
               COALESCE(completed_at, started_at, created_at), '/admin/quality-lab',
               CASE WHEN status = 'failed' THEN 'rerun_quality' ELSE NULL END
        FROM quality_runs WHERE status IN ('failed', 'interrupted')
        UNION ALL
        SELECT id, 'index', 'Index ' || collection_name, status, failure_code,
               updated_at, '/admin/retrieval-ops', NULL
        FROM retrieval_index_jobs WHERE status = 'failed'
        UNION ALL
        SELECT id, 'trace', 'Trace ' || substr(id, 1, 8), status, error_code,
               completed_at, '/admin/retrieval-ops', NULL
        FROM retrieval_traces WHERE status IN ('degraded', 'failed')
        UNION ALL
        SELECT id, 'ocr', engine || ' OCR', status, error_code,
               COALESCE(completed_at, started_at, created_at), '/admin/documents', NULL
        FROM document_extraction_jobs WHERE status = 'failed'
      )
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(bounded) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      kind: row.kind as OperationProblem['kind'],
      title: row.title as string,
      status: row.status as string,
      failureCode: row.failure_code as string | null,
      occurredAt: row.occurred_at as string,
      ownerPath: row.owner_path as string,
      recovery: row.recovery as OperationProblem['recovery'],
    }));
  }

  sqliteMode(): string {
    return String(this.db.pragma('journal_mode', { simple: true })).toLowerCase();
  }

  private countStatuses(
    table: string,
    groups: Record<keyof OperationTaskCounts, string[]>,
  ): OperationTaskCounts {
    const counts = { ...EMPTY_COUNTS };
    for (const [key, statuses] of Object.entries(groups) as Array<[
      keyof OperationTaskCounts,
      string[],
    ]>) {
      if (statuses.length === 0) continue;
      const placeholders = statuses.map(() => '?').join(', ');
      counts[key] = (this.db.prepare(
        `SELECT COUNT(*) AS total FROM ${table} WHERE status IN (${placeholders})`,
      ).get(...statuses) as { total: number }).total;
    }
    return counts;
  }
}
