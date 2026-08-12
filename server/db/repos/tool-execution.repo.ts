import Database from 'better-sqlite3';
import type { ToolExecution, ToolExecutionStatus } from '../../types/order-tool';
import { ConflictError } from '../../utils/errors';

interface ToolExecutionRow {
  id: string;
  session_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  idempotency_key: string | null;
  tool_name: ToolExecution['toolName'];
  tool_version: ToolExecution['toolVersion'];
  adapter_name: string;
  adapter_version: string;
  masked_order_reference: string;
  order_reference_fingerprint: string;
  status: ToolExecutionStatus;
  safe_error_code: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StartToolExecutionInput extends Omit<
  ToolExecution,
  'assistantMessageId' | 'status' | 'safeErrorCode' | 'durationMs' | 'updatedAt' | 'completedAt'
> {}

export class ToolExecutionRepo {
  constructor(private readonly db: Database.Database) {}

  start(input: StartToolExecutionInput): ToolExecution {
    try {
      this.db.prepare(
        `INSERT INTO tool_executions (
           id, session_id, user_message_id, assistant_message_id,
           idempotency_key, tool_name, tool_version, adapter_name,
           adapter_version, masked_order_reference, order_reference_fingerprint,
           status, safe_error_code, duration_ms, result_summary, created_at,
           updated_at, completed_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL,
           NULL, ?, ?, NULL)`,
      ).run(
        input.id,
        input.sessionId,
        input.userMessageId,
        input.idempotencyKey,
        input.toolName,
        input.toolVersion,
        input.adapterName,
        input.adapterVersion,
        input.maskedOrderReference,
        input.orderReferenceFingerprint,
        input.createdAt,
        input.createdAt,
      );
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && String((error as Error & { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
      ) {
        throw new ConflictError('An order lookup is already in progress for this session');
      }
      throw error;
    }
    return this.findById(input.id)!;
  }

  succeed(
    id: string,
    input: { assistantMessageId: string; durationMs: number; resultSummary: object; completedAt: string },
  ): void {
    this.db.prepare(
      `UPDATE tool_executions
       SET status = 'succeeded', assistant_message_id = ?, duration_ms = ?,
           result_summary = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      input.assistantMessageId,
      input.durationMs,
      JSON.stringify(input.resultSummary),
      input.completedAt,
      input.completedAt,
      id,
    );
  }

  fail(id: string, safeErrorCode: string, durationMs: number, completedAt: string): void {
    this.db.prepare(
      `UPDATE tool_executions
       SET status = 'failed', safe_error_code = ?, duration_ms = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(safeErrorCode, durationMs, completedAt, completedAt, id);
  }

  findById(id: string): ToolExecution | null {
    const row = this.db.prepare(
      'SELECT * FROM tool_executions WHERE id = ?',
    ).get(id) as ToolExecutionRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listBySession(sessionId: string): ToolExecution[] {
    const rows = this.db.prepare(
      'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY created_at DESC',
    ).all(sessionId) as ToolExecutionRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: ToolExecutionRow): ToolExecution {
    return {
      id: row.id,
      sessionId: row.session_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      idempotencyKey: row.idempotency_key,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      adapterName: row.adapter_name,
      adapterVersion: row.adapter_version,
      maskedOrderReference: row.masked_order_reference,
      orderReferenceFingerprint: row.order_reference_fingerprint,
      status: row.status,
      safeErrorCode: row.safe_error_code,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}
