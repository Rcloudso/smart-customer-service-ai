import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Message, MessageRole, IntentCategory, KnowledgeRetrievalSnapshot, SatisfactionRating } from '../../types/domain';
import { parseKnowledgeSnapshot } from '../../utils/knowledge-snapshot';

export class MessageRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private findBySessionStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findPreviousUserStmt: Database.Statement;
  private findLegacyPreviousUserStmt: Database.Statement;
  private updateSatisfactionStmt: Database.Statement;
  private updateEscalatedStmt: Database.Statement;
  private countBySessionStmt: Database.Statement;
  private totalMessagesStmt: Database.Statement;
  private avgSatisfactionStmt: Database.Statement;
  private intentDistributionStmt: Database.Statement;
  private satisfactionTrendStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO messages (
        id, session_id, role, content, intent, intent_conf, satisfaction, escalated,
        reply_to_message_id, retrieval_snapshot, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findBySessionStmt = db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    );
    this.findByIdStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
    this.findPreviousUserStmt = db.prepare(
      `SELECT user_message.* FROM messages AS assistant_message
       JOIN messages AS user_message ON user_message.id = assistant_message.reply_to_message_id
       WHERE assistant_message.id = ? AND user_message.role = 'user'`,
    );
    this.findLegacyPreviousUserStmt = db.prepare(
      `SELECT user_message.* FROM messages AS user_message
       JOIN messages AS assistant_message ON assistant_message.id = ?
       WHERE user_message.session_id = assistant_message.session_id
         AND user_message.role = 'user' AND user_message.rowid < assistant_message.rowid
       ORDER BY user_message.rowid DESC LIMIT 1`,
    );
    this.updateSatisfactionStmt = db.prepare(
      'UPDATE messages SET satisfaction = ? WHERE id = ?',
    );
    this.updateEscalatedStmt = db.prepare(
      'UPDATE messages SET escalated = 1 WHERE id = ?',
    );
    this.countBySessionStmt = db.prepare(
      'SELECT COUNT(*) as total FROM messages WHERE session_id = ?',
    );
    this.totalMessagesStmt = db.prepare('SELECT COUNT(*) as total FROM messages');
    this.avgSatisfactionStmt = db.prepare(
      'SELECT AVG(satisfaction) as avg_rating FROM messages WHERE satisfaction IS NOT NULL',
    );
    this.intentDistributionStmt = db.prepare(
      `SELECT intent, COUNT(*) as count FROM messages
       WHERE intent IS NOT NULL AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
       GROUP BY intent`,
    );
    this.satisfactionTrendStmt = db.prepare(
      `SELECT DATE(created_at) as date, AVG(satisfaction) as avg_rating, COUNT(*) as count
       FROM messages
       WHERE satisfaction IS NOT NULL
         AND (? IS NULL OR created_at >= ?)
         AND (? IS NULL OR created_at <= ?)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
    );
  }

  create(params: {
    sessionId: string;
    role: MessageRole;
    content: string;
    intent?: IntentCategory | null;
    intentConf?: number | null;
    replyToMessageId?: string | null;
    retrievalSnapshot?: KnowledgeRetrievalSnapshot[];
  }): Message {
    const now = new Date().toISOString();
    const message: Message = {
      id: uuidv4(),
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      intent: params.intent ?? null,
      intentConf: params.intentConf ?? null,
      satisfaction: null,
      escalated: 0,
      replyToMessageId: params.replyToMessageId ?? null,
      retrievalSnapshot: params.retrievalSnapshot ?? [],
      createdAt: now,
    };

    this.insertStmt.run(
      message.id, message.sessionId, message.role, message.content,
      message.intent, message.intentConf, message.satisfaction,
      message.escalated, message.replyToMessageId,
      JSON.stringify(message.retrievalSnapshot), message.createdAt,
    );
    return message;
  }

  findBySession(sessionId: string): Message[] {
    const rows = this.findBySessionStmt.all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findById(id: string): Message | null {
    const row = this.findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findPreviousUserMessage(assistantMessageId: string): Message | null {
    const linked = this.findPreviousUserStmt.get(assistantMessageId) as Record<string, unknown> | undefined;
    const row = linked ?? this.findLegacyPreviousUserStmt.get(assistantMessageId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  updateSatisfaction(id: string, rating: SatisfactionRating): void {
    this.updateSatisfactionStmt.run(rating, id);
  }

  markEscalated(id: string): void {
    this.updateEscalatedStmt.run(id);
  }

  countBySession(sessionId: string): number {
    const row = this.countBySessionStmt.get(sessionId) as { total: number };
    return row.total;
  }

  totalMessages(): number {
    const row = this.totalMessagesStmt.get() as { total: number };
    return row.total;
  }

  /** Count messages across a specific set of session IDs. */
  totalMessagesForSessions(sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    const placeholders = sessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM messages WHERE session_id IN (${placeholders})`,
    );
    const row = stmt.get(...sessionIds) as { total: number };
    return row.total;
  }

  avgSatisfaction(): number {
    const row = this.avgSatisfactionStmt.get() as { avg_rating: number | null };
    return row.avg_rating ?? 0;
  }

  /** Average satisfaction across a specific set of session IDs. */
  avgSatisfactionForSessions(sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    const placeholders = sessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT AVG(satisfaction) as avg_rating FROM messages
       WHERE satisfaction IS NOT NULL AND session_id IN (${placeholders})`,
    );
    const row = stmt.get(...sessionIds) as { avg_rating: number | null };
    return row.avg_rating ?? 0;
  }

  intentDistribution(dateFrom?: string, dateTo?: string): Array<{ intent: string; count: number }> {
    const rows = this.intentDistributionStmt.all(
      dateFrom ?? null, dateFrom ?? null,
      dateTo ?? null, dateTo ?? null,
    ) as Array<{ intent: string; count: number }>;
    return rows;
  }

  satisfactionTrend(dateFrom?: string, dateTo?: string): Array<{ date: string; avgRating: number; count: number }> {
    const rows = this.satisfactionTrendStmt.all(
      dateFrom ?? null, dateFrom ?? null,
      dateTo ?? null, dateTo ?? null,
    ) as Array<{ date: string; avg_rating: number; count: number }>;
    return rows.map((row) => ({
      date: row.date,
      avgRating: row.avg_rating,
      count: row.count,
    }));
  }

  private mapRow(row: Record<string, unknown>): Message {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as MessageRole,
      content: row.content as string,
      intent: row.intent as IntentCategory | null,
      intentConf: row.intent_conf as number | null,
      satisfaction: row.satisfaction as SatisfactionRating | null,
      escalated: row.escalated as number,
      replyToMessageId: row.reply_to_message_id as string | null,
      retrievalSnapshot: parseKnowledgeSnapshot(row.retrieval_snapshot),
      createdAt: row.created_at as string,
    };
  }
}
