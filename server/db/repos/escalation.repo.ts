import Database from 'better-sqlite3';
import { EscalationLog, EscalationStatus } from '../../types/domain';

export class EscalationRepo {
  private insertStmt: Database.Statement;
  private listPendingStmt: Database.Statement;
  private findBySessionStmt: Database.Statement;
  private countPendingStmt: Database.Statement;
  private countResolvedStmt: Database.Statement;
  private countAllStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO escalation_log (
         id, session_id, reason, status, resolved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listPendingStmt = db.prepare(
      "SELECT * FROM escalation_log WHERE status = 'pending' ORDER BY created_at ASC",
    );
    this.findBySessionStmt = db.prepare(
      'SELECT * FROM escalation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    this.countPendingStmt = db.prepare(
      "SELECT COUNT(*) AS count FROM escalation_log WHERE status = 'pending'",
    );
    this.countResolvedStmt = db.prepare(
      "SELECT COUNT(*) AS count FROM escalation_log WHERE status = 'resolved'",
    );
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS count FROM escalation_log');
  }

  create(escalation: EscalationLog): EscalationLog {
    this.insertStmt.run(
      escalation.id,
      escalation.sessionId,
      escalation.reason,
      escalation.status,
      escalation.resolvedAt,
      escalation.createdAt,
    );
    return escalation;
  }

  listPending(): EscalationLog[] {
    return (this.listPendingStmt.all() as Array<Record<string, unknown>>)
      .map((row) => this.mapRow(row));
  }

  findBySession(sessionId: string): EscalationLog | null {
    const row = this.findBySessionStmt.get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  countByStatus(): { pending: number; resolved: number; total: number } {
    return {
      pending: (this.countPendingStmt.get() as { count: number }).count,
      resolved: (this.countResolvedStmt.get() as { count: number }).count,
      total: (this.countAllStmt.get() as { count: number }).count,
    };
  }

  private mapRow(row: Record<string, unknown>): EscalationLog {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      reason: row.reason as string,
      status: row.status as EscalationStatus,
      resolvedAt: row.resolved_at as string | null,
      createdAt: row.created_at as string,
    };
  }
}
