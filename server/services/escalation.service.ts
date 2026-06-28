import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db';
import { EscalationLog, EscalationStatus, SessionStatus } from '../types/domain';
import { logger } from '../utils/logger';

export class EscalationService {
  private db: ReturnType<typeof getDatabase>;

  constructor() {
    this.db = getDatabase();
  }

  checkEscalation(content: string): { shouldEscalate: boolean; reason: string | null } {
    const explicitTriggers = ['转人工', '人工客服', '找人工', '找客服', '人工服务', '投诉', '我要投诉'];

    const hasExplicit = explicitTriggers.some((t) => content.includes(t));
    if (hasExplicit) {
      return { shouldEscalate: true, reason: '用户要求转人工客服' };
    }

    const frustrationTriggers = ['一直说', '没用', '听不懂', '机器人', '破系统', '垃圾'];
    const hasFrustration = frustrationTriggers.some((t) => content.includes(t));
    if (hasFrustration) {
      return { shouldEscalate: true, reason: '用户表达不满情绪' };
    }

    return { shouldEscalate: false, reason: null };
  }

  createEscalation(sessionId: string, reason: string): EscalationLog {
    const now = new Date().toISOString();
    const escalation: EscalationLog = {
      id: uuidv4(),
      sessionId,
      reason,
      status: EscalationStatus.PENDING,
      resolvedAt: null,
      createdAt: now,
    };

    const stmt = this.db.prepare(
      'INSERT INTO escalation_log (id, session_id, reason, status, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run(escalation.id, escalation.sessionId, escalation.reason, escalation.status, escalation.resolvedAt, escalation.createdAt);

    // Update session status
    const sessionStmt = this.db.prepare(
      "UPDATE sessions SET status = 'escalated', updated_at = ? WHERE id = ?",
    );
    sessionStmt.run(now, sessionId);

    logger.info({ escalationId: escalation.id, sessionId, reason }, 'Escalation created');
    return escalation;
  }

  getQueue(): EscalationLog[] {
    const stmt = this.db.prepare(
      "SELECT * FROM escalation_log WHERE status = 'pending' ORDER BY created_at ASC",
    );
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getQueueStatus(): { pending: number; resolved: number; total: number } {
    const pendingStmt = this.db.prepare("SELECT COUNT(*) as count FROM escalation_log WHERE status = 'pending'");
    const resolvedStmt = this.db.prepare("SELECT COUNT(*) as count FROM escalation_log WHERE status = 'resolved'");
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM escalation_log');

    const pending = (pendingStmt.get() as { count: number }).count;
    const resolved = (resolvedStmt.get() as { count: number }).count;
    const total = (totalStmt.get() as { count: number }).count;

    return { pending, resolved, total };
  }

  findBySession(sessionId: string): EscalationLog | null {
    const stmt = this.db.prepare('SELECT * FROM escalation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1');
    const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
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

export const escalationService = new EscalationService();
