import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db';
import { DocumentRepo } from '../db/repos/document.repo';

function createV029DocumentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      parser_version TEXT NOT NULL,
      chunker_version TEXT NOT NULL,
      failure_code TEXT,
      character_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      title TEXT,
      page_start INTEGER,
      page_end INTEGER,
      character_count INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      embedding_profile TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(document_id, chunk_index)
    );
  `);
  db.prepare(`
    INSERT INTO documents (
      id, file_name, storage_path, format, mime_type, size_bytes, sha256,
      status, is_active, parser_version, chunker_version, failure_code,
      character_count, chunk_count, uploaded_by, created_at, updated_at
    ) VALUES (
      'legacy-document', 'legacy.txt', 'legacy.txt', 'txt', 'text/plain', 24,
      ?, 'ready', 1, 'text-v1', 'semantic-v1', NULL, 24, 1, 'admin',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    )
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO document_chunks (
      id, document_id, chunk_index, content, title, page_start, page_end,
      character_count, embedding, embedding_profile, created_at
    ) VALUES (
      'legacy-chunk', 'legacy-document', 0, 'Legacy searchable content.', NULL,
      NULL, NULL, 26, '[1,0]', NULL, '2026-07-01T00:00:00.000Z'
    )
  `).run();
}

try {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createV029DocumentTables(db);
  initSchema(db);
  initSchema(db);

  const repo = new DocumentRepo(db);
  const document = repo.findById('legacy-document');
  assert.ok(document);
  assert.equal(document.status, 'ready');
  assert.equal(document.representationVersion, null);
  assert.equal(document.qualityDecision, null);
  assert.deepEqual(document.qualityReasons, []);
  assert.equal(document.indexStatus, 'legacy');

  const chunks = repo.listChunks('legacy-document', 20, 0);
  assert.equal(chunks.total, 1);
  assert.deepEqual(chunks.items[0].sourceBlockIds, []);
  assert.deepEqual(chunks.items[0].headingPath, []);
  assert.equal(chunks.items[0].representationVersion, null);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS total
      FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'document_processing_tasks',
        'document_processing_stages',
        'document_representations',
        'document_representation_blocks',
        'document_extraction_jobs',
        'document_review_drafts',
        'document_review_blocks'
      )
    `).get() as { total: number }).total,
    7,
  );
  db.close();
  console.log('document migration tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
