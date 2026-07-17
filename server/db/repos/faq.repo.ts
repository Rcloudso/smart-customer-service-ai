import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { FaqEntry, IntentCategory } from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';

export class FaqRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private updateEmbeddingStmt: Database.Statement;
  private updateEmbeddingCasStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private listStmt: Database.Statement;
  private listAllActiveStmt: Database.Statement;
  private listByCategoryStmt: Database.Statement;
  private searchLikeStmt: Database.Statement;
  private countByCategoryStmt: Database.Statement;
  private searchWithFiltersStmt: Database.Statement;
  private countWithFiltersStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO faq_entries (
         id, question, answer, category, keywords, embedding, embedding_profile,
         is_active, created_at, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE faq_entries SET question = ?, answer = ?, category = ?, keywords = ?,
       embedding = ?, embedding_profile = ?, is_active = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    );
    this.updateEmbeddingStmt = db.prepare(
      'UPDATE faq_entries SET embedding = ?, embedding_profile = ? WHERE id = ?',
    );
    this.updateEmbeddingCasStmt = db.prepare(
      `UPDATE faq_entries
       SET embedding = ?, embedding_profile = ?
       WHERE id = ? AND updated_at = ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM faq_entries WHERE id = ?');
    this.findByIdStmt = db.prepare('SELECT * FROM faq_entries WHERE id = ?');
    this.listStmt = db.prepare(
      'SELECT * FROM faq_entries WHERE is_active = 1 AND (? IS NULL OR category = ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    );
    this.listAllActiveStmt = db.prepare(
      "SELECT * FROM faq_entries WHERE is_active = 1 ORDER BY category, updated_at DESC",
    );
    this.listByCategoryStmt = db.prepare(
      'SELECT * FROM faq_entries WHERE category = ? AND is_active = 1 ORDER BY updated_at DESC',
    );
    this.searchLikeStmt = db.prepare(
      `SELECT * FROM faq_entries
       WHERE is_active = 1 AND (question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC LIMIT ?`,
    );
    this.countByCategoryStmt = db.prepare(
      'SELECT COUNT(*) as total FROM faq_entries WHERE is_active = 1 AND (? IS NULL OR category = ?)',
    );
    this.searchWithFiltersStmt = db.prepare(
      `SELECT * FROM faq_entries
         WHERE is_active = 1
           AND (? IS NULL OR category = ?)
         AND (? IS NULL OR (question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\'))
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    );
    this.countWithFiltersStmt = db.prepare(
      `SELECT COUNT(*) as total FROM faq_entries
         WHERE is_active = 1
           AND (? IS NULL OR category = ?)
         AND (? IS NULL OR (question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\'))`,
    );
  }

  create(params: {
    question: string;
    answer: string;
    category: IntentCategory;
    keywords: string[];
    embedding?: number[] | null;
    embeddingProfile?: string | null;
    isActive?: number;
    updatedBy?: string | null;
  }): FaqEntry {
    const now = new Date().toISOString();
    const entry: FaqEntry = {
      id: uuidv4(),
      question: params.question,
      answer: params.answer,
      category: params.category,
      keywords: params.keywords,
      embedding: params.embedding ?? null,
      embeddingProfile: params.embeddingProfile ?? null,
      isActive: params.isActive ?? 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: params.updatedBy ?? null,
    };

    this.insertStmt.run(
      entry.id, entry.question, entry.answer, entry.category,
      JSON.stringify(entry.keywords),
      entry.embedding ? JSON.stringify(entry.embedding) : null,
      entry.embeddingProfile,
      entry.isActive, entry.createdAt, entry.updatedAt, entry.updatedBy,
    );
    return entry;
  }

  update(id: string, params: {
    question?: string;
    answer?: string;
    category?: IntentCategory;
    keywords?: string[];
    embedding?: number[] | null;
    embeddingProfile?: string | null;
    isActive?: number;
    updatedBy?: string | null;
  }): FaqEntry | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const question = params.question ?? existing.question;
    const answer = params.answer ?? existing.answer;
    const category = params.category ?? existing.category;
    const keywords = params.keywords ?? existing.keywords;
    const embedding = params.embedding !== undefined ? params.embedding : existing.embedding;
    const embeddingProfile = params.embeddingProfile !== undefined
      ? params.embeddingProfile
      : params.embedding === null
        ? null
        : existing.embeddingProfile;
    const isActive = params.isActive !== undefined ? params.isActive : existing.isActive;
    const updatedBy = params.updatedBy !== undefined ? params.updatedBy : existing.updatedBy;

    this.updateStmt.run(
      question, answer, category, JSON.stringify(keywords),
      embedding ? JSON.stringify(embedding) : null,
      embeddingProfile,
      isActive, now, updatedBy, id,
    );

    return this.findById(id);
  }

  updateEmbedding(
    id: string,
    embedding: number[] | null,
    embeddingProfile: string | null = null,
    expectedUpdatedAt?: string,
  ): FaqEntry | null {
    const serialized = embedding ? JSON.stringify(embedding) : null;
    const result = expectedUpdatedAt
      ? this.updateEmbeddingCasStmt.run(serialized, embeddingProfile, id, expectedUpdatedAt)
      : this.updateEmbeddingStmt.run(serialized, embeddingProfile, id);
    if (result.changes === 0) {
      return null;
    }
    return this.findById(id);
  }

  updateEmbeddings(
    updates: Array<{
      id: string;
      embedding: number[] | null;
      embeddingProfile: string | null;
      expectedUpdatedAt?: string;
    }>,
  ): void {
    this.db.transaction(() => {
      for (const update of updates) {
        const serialized = update.embedding ? JSON.stringify(update.embedding) : null;
        const result = update.expectedUpdatedAt
          ? this.updateEmbeddingCasStmt.run(
              serialized,
              update.embeddingProfile,
              update.id,
              update.expectedUpdatedAt,
            )
          : this.updateEmbeddingStmt.run(serialized, update.embeddingProfile, update.id);
        if (result.changes !== 1) {
          throw new Error('FAQ changed while its embedding was being generated');
        }
      }
    })();
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  findById(id: string): FaqEntry | null {
    const row = this.findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(category: IntentCategory | null, limit: number, offset: number): FaqEntry[] {
    const rows = this.listStmt.all(category, category, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  listAllActive(): FaqEntry[] {
    const rows = this.listAllActiveStmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  listByCategory(category: IntentCategory): FaqEntry[] {
    const rows = this.listByCategoryStmt.all(category) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  searchLike(query: string, limit: number): FaqEntry[] {
    const likeQuery = `%${escapeLikePattern(query)}%`;
    const rows = this.searchLikeStmt.all(likeQuery, likeQuery, likeQuery, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  countByCategory(category: IntentCategory | null): number {
    const row = this.countByCategoryStmt.get(category, category) as { total: number };
    return row.total;
  }

  /**
   * Combined keyword + category search pushed down to SQL with pagination.
   * Returns both the page of results and the total matching count.
   */
  searchWithFilters(params: {
    keyword: string;
    category: IntentCategory | null;
    limit: number;
    offset: number;
  }): { items: FaqEntry[]; total: number } {
    const likePattern = `%${escapeLikePattern(params.keyword)}%`;
    const rows = this.searchWithFiltersStmt.all(
      params.category, params.category,
      params.keyword, likePattern, likePattern, likePattern,
      params.limit, params.offset,
    ) as Record<string, unknown>[];
    const totalRow = this.countWithFiltersStmt.get(
      params.category, params.category,
      params.keyword, likePattern, likePattern, likePattern,
    ) as { total: number };
    return {
      items: rows.map((row) => this.mapRow(row)),
      total: totalRow.total,
    };
  }

  private mapRow(row: Record<string, unknown>): FaqEntry {
    return {
      id: row.id as string,
      question: row.question as string,
      answer: row.answer as string,
      category: row.category as IntentCategory,
      keywords: JSON.parse((row.keywords as string) || '[]') as string[],
      embedding: row.embedding ? (JSON.parse(row.embedding as string) as number[]) : null,
      embeddingProfile: row.embedding_profile as string | null,
      isActive: row.is_active as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      updatedBy: row.updated_by as string | null,
    };
  }
}
