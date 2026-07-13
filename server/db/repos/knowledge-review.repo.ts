import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  IntentCategory,
  KnowledgeRetrievalSnapshot,
  KnowledgeReviewItem,
  KnowledgeReviewStatus,
  KnowledgeReviewTriggerReason,
  SatisfactionRating,
} from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';
import { parseKnowledgeSnapshot } from '../../utils/knowledge-snapshot';

export class KnowledgeReviewRepo {
  constructor(private readonly db: Database.Database) {}

  create(params: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
    question: string;
    answer: string;
    intent: IntentCategory | null;
    intentConf: number | null;
    retrievalSnapshot: KnowledgeRetrievalSnapshot[];
    triggerReason: KnowledgeReviewTriggerReason;
    rating?: SatisfactionRating | null;
  }): KnowledgeReviewItem {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_review_items (
        id, session_id, user_message_id, assistant_message_id, question, answer,
        intent, intent_conf, retrieval_snapshot, trigger_reason, rating, status,
        linked_faq_id, dismiss_reason, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
    ).run(
      uuidv4(), params.sessionId, params.userMessageId, params.assistantMessageId,
      params.question, params.answer, params.intent, params.intentConf,
      JSON.stringify(params.retrievalSnapshot.slice(0, 3)), params.triggerReason,
      params.rating ?? null, now, now,
    );
    return this.findByUserMessageId(params.userMessageId) as KnowledgeReviewItem;
  }

  findById(id: string): KnowledgeReviewItem | null {
    const row = this.db.prepare('SELECT * FROM knowledge_review_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByUserMessageId(userMessageId: string): KnowledgeReviewItem | null {
    const row = this.db.prepare('SELECT * FROM knowledge_review_items WHERE user_message_id = ?').get(userMessageId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  updatePendingFeedback(id: string, rating: SatisfactionRating): KnowledgeReviewItem {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE knowledge_review_items
       SET trigger_reason = 'negative_feedback', rating = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(rating, now, id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  updateRating(id: string, rating: SatisfactionRating): KnowledgeReviewItem {
    this.db.prepare('UPDATE knowledge_review_items SET rating = ?, updated_at = ? WHERE id = ?')
      .run(rating, new Date().toISOString(), id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  setLinkedFaq(id: string, faqId: string): KnowledgeReviewItem {
    this.db.prepare(
      `UPDATE knowledge_review_items
       SET linked_faq_id = COALESCE(linked_faq_id, ?), updated_at = ?
       WHERE id = ?`,
    ).run(faqId, new Date().toISOString(), id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  clearLinkedFaq(id: string): KnowledgeReviewItem {
    this.db.prepare(
      'UPDATE knowledge_review_items SET linked_faq_id = NULL, updated_at = ? WHERE id = ?',
    ).run(new Date().toISOString(), id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  markConverted(id: string): KnowledgeReviewItem {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE knowledge_review_items
       SET status = 'converted', updated_at = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(now, now, id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  dismiss(id: string, reason: string | null): KnowledgeReviewItem {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE knowledge_review_items
       SET status = 'dismissed', dismiss_reason = ?, updated_at = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(reason, now, now, id);
    return this.findById(id) as KnowledgeReviewItem;
  }

  list(params: {
    status?: KnowledgeReviewStatus;
    triggerReason?: KnowledgeReviewTriggerReason;
    keyword?: string;
    limit: number;
    offset: number;
  }): { items: KnowledgeReviewItem[]; total: number } {
    const keyword = params.keyword?.trim() ?? '';
    const like = `%${escapeLikePattern(keyword)}%`;
    const filters = `(? IS NULL OR status = ?)
      AND (? IS NULL OR trigger_reason = ?)
      AND (? = '' OR question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')`;
    const args = [
      params.status ?? null, params.status ?? null,
      params.triggerReason ?? null, params.triggerReason ?? null,
      keyword, like, like,
    ];
    const rows = this.db.prepare(
      `SELECT * FROM knowledge_review_items WHERE ${filters}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...args, params.limit, params.offset) as Record<string, unknown>[];
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM knowledge_review_items WHERE ${filters}`,
    ).get(...args) as { total: number }).total;
    return { items: rows.map((row) => this.mapRow(row)), total };
  }

  getStats(): { pending: number; converted: number; dismissed: number; total: number } {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) AS count FROM knowledge_review_items GROUP BY status',
    ).all() as Array<{ status: KnowledgeReviewStatus; count: number }>;
    const result = { pending: 0, converted: 0, dismissed: 0, total: 0 };
    for (const row of rows) {
      result[row.status] = row.count;
      result.total += row.count;
    }
    return result;
  }

  private mapRow(row: Record<string, unknown>): KnowledgeReviewItem {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userMessageId: row.user_message_id as string,
      assistantMessageId: row.assistant_message_id as string,
      question: row.question as string,
      answer: row.answer as string,
      intent: row.intent as IntentCategory | null,
      intentConf: row.intent_conf as number | null,
      retrievalSnapshot: parseKnowledgeSnapshot(row.retrieval_snapshot),
      triggerReason: row.trigger_reason as KnowledgeReviewTriggerReason,
      rating: row.rating as SatisfactionRating | null,
      status: row.status as KnowledgeReviewStatus,
      linkedFaqId: row.linked_faq_id as string | null,
      dismissReason: row.dismiss_reason as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      resolvedAt: row.resolved_at as string | null,
    };
  }
}
