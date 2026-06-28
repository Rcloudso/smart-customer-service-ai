import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AdminUser, AdminRole } from '../../types/domain';

export class AdminRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private findByUsernameStmt: Database.Statement;
  private findByIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      'INSERT INTO admin_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.findByUsernameStmt = db.prepare('SELECT * FROM admin_users WHERE username = ?');
    this.findByIdStmt = db.prepare('SELECT * FROM admin_users WHERE id = ?');
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
