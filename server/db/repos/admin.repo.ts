import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AdminUser, AdminRole } from '../../types/domain';

export class AdminRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private findByUsernameStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private listAllStmt: Database.Statement;
  private updateIdentityAndPasswordStmt: Database.Statement;
  private deleteAllExceptStmt: Database.Statement;
  private countStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      'INSERT INTO admin_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.findByUsernameStmt = db.prepare('SELECT * FROM admin_users WHERE username = ?');
    this.findByIdStmt = db.prepare('SELECT * FROM admin_users WHERE id = ?');
    this.listAllStmt = db.prepare(
      'SELECT * FROM admin_users ORDER BY created_at ASC, id ASC',
    );
    this.updateIdentityAndPasswordStmt = db.prepare(
      'UPDATE admin_users SET username = ?, password_hash = ? WHERE id = ?',
    );
    this.deleteAllExceptStmt = db.prepare('DELETE FROM admin_users WHERE id <> ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS count FROM admin_users');
  }

  create(username: string, passwordHash: string, role: AdminRole = AdminRole.ADMIN): AdminUser {
    const now = new Date().toISOString();
    const user: AdminUser = {
      id: uuidv4(),
      username,
      passwordHash,
      role,
      createdAt: now,
    };

    this.insertStmt.run(user.id, user.username, user.passwordHash, user.role, user.createdAt);
    return user;
  }

  findByUsername(username: string): AdminUser | null {
    const row = this.findByUsernameStmt.get(username) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findById(id: string): AdminUser | null {
    const row = this.findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listAll(): AdminUser[] {
    const rows = this.listAllStmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  updateIdentityAndPassword(id: string, username: string, passwordHash: string): void {
    this.updateIdentityAndPasswordStmt.run(username, passwordHash, id);
  }

  deleteAllExcept(id: string): number {
    return this.deleteAllExceptStmt.run(id).changes;
  }

  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  private mapRow(row: Record<string, unknown>): AdminUser {
    return {
      id: row.id as string,
      username: row.username as string,
      passwordHash: row.password_hash as string,
      role: row.role as AdminRole,
      createdAt: row.created_at as string,
    };
  }
}
