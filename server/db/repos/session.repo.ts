import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Session, SessionStatus } from '../../types/domain';

export class SessionRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findByUserIdentStmt: Database.Statement;
  private listStmt: Database.Statement;
  private countStmt: Database.Statement;
  private activeCountStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      'INSERT INTO sessions (id, user_ident, status, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.updateStatusStmt = db.prepare(
      'UPDATE sessions SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?',
    );
    this.findByIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.findByUserIdentStmt = db.prepare(
      'SELECT * FROM sessions WHERE user_ident = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
    );
    this.listStmt = db.prepare(
      'SELECT * FROM sessions WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.countStmt = db.prepare(
      'SELECT COUNT(*) as total FROM sessions WHERE (? IS NULL OR status = ?)',
    );
    this.activeCountStmt = db.prepare(
      "SELECT COUNT(*) as total FROM sessions WHERE status = 'active'",
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
    };

    this.insertStmt.run(session.id, session.userIdent, session.status, session.createdAt, session.updatedAt, session.closedAt);
    return session;
  }

  updateStatus(id: string, status: SessionStatus): Session | null {
    const now = new Date().toISOString();
    const closedAt = status === SessionStatus.CLOSED ? now : null;
    this.updateStatusStmt.run(status, now, closedAt, id);
    return this.findById(id);
  }

  findById(id: string): Session | null {
    const row = this.findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByUserIdent(userIdent: string, status: SessionStatus = SessionStatus.ACTIVE): Session | null {
    const row = this.findByUserIdentStmt.get(userIdent, status) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(status: SessionStatus | null, limit: number, offset: number): Session[] {
    const rows = this.listStmt.all(status, status, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  count(status: SessionStatus | null): number {
    const row = this.countStmt.get(status, status) as { total: number };
    return row.total;
  }

  activeCount(): number {
    const row = this.activeCountStmt.get() as { total: number };
    return row.total;
  }

  private mapRow(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      userIdent: row.user_ident as string,
      status: row.status as SessionStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: row.closed_at as string | null,
    };
  }
}
