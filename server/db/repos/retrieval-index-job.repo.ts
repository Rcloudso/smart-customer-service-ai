import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  RetrievalIndexJob,
  RetrievalIndexJobStatus,
} from '../../types/retrieval-ops';

interface JobRow {
  id: string;
  status: RetrievalIndexJobStatus;
  collection_name: string;
  embedding_profile: string;
  vector_dimension: number;
  knowledge_fingerprint: string;
  expected_count: number;
  completed_count: number;
  batch_checkpoint: number;
  previous_collection: string | null;
  failure_code: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  rolled_back_at: string | null;
  updated_at: string;
}

export class RetrievalIndexJobRepo {
  constructor(private readonly db: Database.Database) {}

  create(params: {
    collection: string;
    embeddingProfile: string;
    vectorDimension: number;
    knowledgeFingerprint: string;
    expectedCount: number;
    createdBy: string;
    now: string;
  }): RetrievalIndexJob {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO retrieval_index_jobs (
        id, status, collection_name, embedding_profile, vector_dimension,
        knowledge_fingerprint, expected_count, completed_count, batch_checkpoint,
        previous_collection, failure_code, created_by, created_at, started_at,
        ready_at, activated_at, rolled_back_at, updated_at
      ) VALUES (?, 'queued', ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)
    `).run(
      id,
      params.collection,
      params.embeddingProfile,
      params.vectorDimension,
      params.knowledgeFingerprint,
      params.expectedCount,
      params.createdBy,
      params.now,
      params.now,
    );
    return this.get(id) as RetrievalIndexJob;
  }

  get(id: string): RetrievalIndexJob | null {
    const row = this.db.prepare(
      'SELECT * FROM retrieval_index_jobs WHERE id = ?',
    ).get(id) as JobRow | undefined;
    return row ? this.map(row) : null;
  }

  list(limit: number, offset: number): RetrievalIndexJob[] {
    const rows = this.db.prepare(
      'SELECT * FROM retrieval_index_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as JobRow[];
    return rows.map((row) => this.map(row));
  }

  count(): number {
    return (this.db.prepare(
      'SELECT COUNT(*) AS total FROM retrieval_index_jobs',
    ).get() as { total: number }).total;
  }

  findReusable(fingerprint: string, embeddingProfile: string): RetrievalIndexJob | null {
    const row = this.db.prepare(`
      SELECT * FROM retrieval_index_jobs
      WHERE knowledge_fingerprint = ? AND embedding_profile = ?
        AND status IN ('queued', 'running', 'interrupted', 'ready', 'active')
      ORDER BY created_at DESC LIMIT 1
    `).get(fingerprint, embeddingProfile) as JobRow | undefined;
    return row ? this.map(row) : null;
  }

  nextPending(): RetrievalIndexJob | null {
    const row = this.db.prepare(`
      SELECT * FROM retrieval_index_jobs
      WHERE status IN ('queued', 'interrupted')
      ORDER BY CASE status WHEN 'interrupted' THEN 0 ELSE 1 END, created_at
      LIMIT 1
    `).get() as JobRow | undefined;
    return row ? this.map(row) : null;
  }

  markRunning(id: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE retrieval_index_jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('queued', 'interrupted')
    `).run(now, now, id).changes === 1;
  }

  saveCheckpoint(id: string, checkpoint: number, completedCount: number, now: string): void {
    this.db.prepare(`
      UPDATE retrieval_index_jobs
      SET batch_checkpoint = ?, completed_count = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(checkpoint, completedCount, now, id);
  }

  markReady(id: string, now: string): void {
    this.db.prepare(`
      UPDATE retrieval_index_jobs
      SET status = 'ready', completed_count = expected_count,
          ready_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, now, id);
  }

  markFailed(id: string, failureCode: string, now: string): void {
    this.db.prepare(`
      UPDATE retrieval_index_jobs
      SET status = 'failed', failure_code = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'interrupted')
    `).run(failureCode, now, id);
  }

  markStale(id: string, now: string): void {
    this.db.prepare(`
      UPDATE retrieval_index_jobs SET status = 'stale', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'interrupted', 'ready')
    `).run(now, id);
  }

  interruptRunning(now: string): number {
    return this.db.prepare(`
      UPDATE retrieval_index_jobs SET status = 'interrupted', updated_at = ?
      WHERE status = 'running'
    `).run(now).changes;
  }

  activate(id: string, previousCollection: string | null, now: string): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE retrieval_index_jobs
        SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?
        WHERE status = 'active' AND id <> ?
      `).run(now, now, id);
      this.db.prepare(`
        UPDATE retrieval_index_jobs
        SET status = 'active', previous_collection = ?, activated_at = ?,
            rolled_back_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(previousCollection, now, now, id);
    })();
  }

  activateRollbackTarget(id: string, now: string): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE retrieval_index_jobs
        SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?
        WHERE status = 'active' AND id <> ?
      `).run(now, now, id);
      this.db.prepare(`
        UPDATE retrieval_index_jobs
        SET status = 'active', activated_at = ?, rolled_back_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'rolled_back'
      `).run(now, now, id);
    })();
  }

  rollBack(id: string, now: string): void {
    this.db.prepare(`
      UPDATE retrieval_index_jobs
      SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(now, now, id);
  }

  findByCollection(collection: string): RetrievalIndexJob | null {
    const row = this.db.prepare(`
      SELECT * FROM retrieval_index_jobs WHERE collection_name = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(collection) as JobRow | undefined;
    return row ? this.map(row) : null;
  }

  private map(row: JobRow): RetrievalIndexJob {
    return {
      id: row.id,
      status: row.status,
      collection: row.collection_name,
      embeddingProfile: row.embedding_profile,
      vectorDimension: row.vector_dimension,
      knowledgeFingerprint: row.knowledge_fingerprint,
      expectedCount: row.expected_count,
      completedCount: row.completed_count,
      checkpoint: row.batch_checkpoint,
      previousCollection: row.previous_collection,
      failureCode: row.failure_code,
      createdBy: row.created_by,
      createdAt: row.created_at,
      startedAt: row.started_at,
      readyAt: row.ready_at,
      activatedAt: row.activated_at,
      rolledBackAt: row.rolled_back_at,
      updatedAt: row.updated_at,
    };
  }
}
