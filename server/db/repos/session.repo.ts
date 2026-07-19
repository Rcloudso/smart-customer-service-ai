import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { IntentCategory, MessageRole, SatisfactionRating, Session, SessionStatus } from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';

export interface ConversationFilters {
  intent?: IntentCategory;
  status?: SessionStatus;
  keyword?: string;
  createdFrom?: string;
  createdToExclusive?: string;
}

export interface ConversationListItem extends Session {
  messageCount: number;
}

export interface ConversationExportRow {
  sessionId: string;
  userIdent: string;
  status: SessionStatus;
  sessionCreatedAt: string;
  messageId: string;
  role: MessageRole;
  content: string;
  intent: IntentCategory | null;
  satisfaction: SatisfactionRating | null;
  messageCreatedAt: string;
}

export class SessionRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private touchStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findByUserIdentStmt: Database.Statement;
  private listByUserIdentStmt: Database.Statement;
  private countByUserIdentStmt: Database.Statement;
  private listStmt: Database.Statement;
  private countStmt: Database.Statement;
  private expireInactiveStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO sessions (
         id, user_ident, status, created_at, updated_at, closed_at, close_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStatusStmt = db.prepare(
      `UPDATE sessions
       SET status = ?, updated_at = ?, closed_at = ?, close_reason = ?
       WHERE id = ?`,
    );
    this.touchStmt = db.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?',
    );
    this.findByIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.findByUserIdentStmt = db.prepare(
      'SELECT * FROM sessions WHERE user_ident = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
    );
    this.listByUserIdentStmt = db.prepare(
      'SELECT * FROM sessions WHERE user_ident = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    );
    this.countByUserIdentStmt = db.prepare(
      'SELECT COUNT(*) as total FROM sessions WHERE user_ident = ?',
    );
    this.listStmt = db.prepare(
      'SELECT * FROM sessions WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.countStmt = db.prepare(
      'SELECT COUNT(*) as total FROM sessions WHERE (? IS NULL OR status = ?)',
    );
    this.expireInactiveStmt = db.prepare(
      `UPDATE sessions
       SET status = 'closed', closed_at = ?, close_reason = 'inactivity_timeout'
       WHERE status = 'active' AND updated_at < ?`,
    );
  }

  create(userIdent: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: uuidv4(),
      userIdent,
      status: SessionStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closeReason: null,
    };

    this.insertStmt.run(
      session.id,
      session.userIdent,
      session.status,
      session.createdAt,
      session.updatedAt,
      session.closedAt,
      session.closeReason,
    );
    return session;
  }

  updateStatus(id: string, status: SessionStatus, closeReason: string | null = null): Session | null {
    const now = new Date().toISOString();
    const closedAt = status === SessionStatus.CLOSED ? now : null;
    this.updateStatusStmt.run(status, now, closedAt, closeReason, id);
    return this.findById(id);
  }

  expireInactive(cutoff: string, closedAt: string): number {
    return this.expireInactiveStmt.run(closedAt, cutoff).changes;
  }

  hasInactive(cutoff: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM sessions WHERE status = 'active' AND updated_at < ? LIMIT 1",
    ).get(cutoff));
  }

  touch(id: string): void {
    this.touchStmt.run(new Date().toISOString(), id);
  }

  findById(id: string): Session | null {
    const row = this.findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByUserIdent(userIdent: string, status: SessionStatus = SessionStatus.ACTIVE): Session | null {
    const row = this.findByUserIdentStmt.get(userIdent, status) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByUserIdent(userIdent: string, limit: number, offset: number): Session[] {
    const rows = this.listByUserIdentStmt.all(userIdent, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  countByUserIdent(userIdent: string): number {
    const row = this.countByUserIdentStmt.get(userIdent) as { total: number };
    return row.total;
  }

  list(status: SessionStatus | null, limit: number, offset: number): Session[] {
    const rows = this.listStmt.all(status, status, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  count(status: SessionStatus | null): number {
    const row = this.countStmt.get(status, status) as { total: number };
    return row.total;
  }

  activeCount(cutoff: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as total FROM sessions WHERE status = 'active' AND updated_at >= ?",
    ).get(cutoff) as { total: number };
    return row.total;
  }

  listWithFilters(
    filters: ConversationFilters,
    limit: number,
    offset: number,
  ): ConversationListItem[] {
    const { whereClause, params } = this.buildFilterSql(filters);
    const rows = this.db.prepare(
      `SELECT
         s.*,
         COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       ${whereClause}
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Array<Record<string, unknown> & { message_count: number }>;

    return rows.map((row) => ({
      ...this.mapRow(row),
      messageCount: row.message_count,
    }));
  }

  countWithFilters(filters: ConversationFilters): number {
    const { whereClause, params } = this.buildFilterSql(filters);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM sessions s ${whereClause}`,
    ).get(...params) as { total: number };
    return row.total;
  }

  countExportMessages(filters: ConversationFilters): number {
    const { whereClause, params } = this.buildFilterSql(filters);
    const row = this.db.prepare(
      `SELECT COUNT(m.id) AS total
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       ${whereClause}`,
    ).get(...params) as { total: number };
    return row.total;
  }

  exportMessageRows(filters: ConversationFilters, limit: number): ConversationExportRow[] {
    const { whereClause, params } = this.buildFilterSql(filters);
    const rows = this.db.prepare(
      `SELECT
         s.id AS session_id,
         s.user_ident,
         s.status,
         s.created_at AS session_created_at,
         m.id AS message_id,
         m.role,
         m.content,
         m.intent,
         m.satisfaction,
         m.created_at AS message_created_at
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       ${whereClause}
       ORDER BY s.created_at DESC, m.created_at ASC
       LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      sessionId: row.session_id as string,
      userIdent: row.user_ident as string,
      status: row.status as SessionStatus,
      sessionCreatedAt: row.session_created_at as string,
      messageId: row.message_id as string,
      role: row.role as MessageRole,
      content: row.content as string,
      intent: row.intent as IntentCategory | null,
      satisfaction: row.satisfaction as SatisfactionRating | null,
      messageCreatedAt: row.message_created_at as string,
    }));
  }

  private buildFilterSql(filters: ConversationFilters): {
    whereClause: string;
    params: unknown[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.createdFrom) {
      conditions.push('s.created_at >= ?');
      params.push(filters.createdFrom);
    }
    if (filters.createdToExclusive) {
      conditions.push('s.created_at < ?');
      params.push(filters.createdToExclusive);
    }
    if (filters.intent) {
      conditions.push(
        'EXISTS (SELECT 1 FROM messages mi WHERE mi.session_id = s.id AND mi.intent = ?)',
      );
      params.push(filters.intent);
    }
    if (filters.status) {
      conditions.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.keyword) {
      conditions.push(
        "EXISTS (SELECT 1 FROM messages mk WHERE mk.session_id = s.id AND LOWER(mk.content) LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escapeLikePattern(filters.keyword.toLowerCase())}%`);
    }
    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  private mapRow(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      userIdent: row.user_ident as string,
      status: row.status as SessionStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: row.closed_at as string | null,
      closeReason: row.close_reason as string | null,
    };
  }
}
