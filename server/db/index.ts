import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  // Ensure data directory exists
  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.db.path);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initSchema(db);
  logger.info({ dbPath: config.db.path }, 'Database initialized');
  return db;
}

export function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_ident TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'escalated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      intent TEXT CHECK(intent IN ('refund', 'order', 'technical', 'general')),
      intent_conf REAL,
      satisfaction INTEGER CHECK(satisfaction >= 1 AND satisfaction <= 5),
      escalated INTEGER NOT NULL DEFAULT 0,
      reply_to_message_id TEXT REFERENCES messages(id),
      retrieval_snapshot TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

    CREATE TABLE IF NOT EXISTS faq_entries (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('refund', 'order', 'technical', 'general')),
      keywords TEXT NOT NULL DEFAULT '[]',
      embedding TEXT,
      embedding_profile TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_faq_entries_category ON faq_entries(category);
    CREATE INDEX IF NOT EXISTS idx_faq_entries_is_active ON faq_entries(is_active);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('txt', 'md', 'pdf', 'docx')),
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready', 'failed')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      parser_version TEXT NOT NULL,
      chunker_version TEXT NOT NULL,
      failure_code TEXT,
      character_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256);
    CREATE INDEX IF NOT EXISTS idx_documents_status_updated ON documents(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_active_updated ON documents(is_active, updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_chunks (
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

    CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id, chunk_index);

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'super_admin')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalation_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved', 'dismissed')),
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_escalation_log_session_id ON escalation_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_escalation_log_status ON escalation_log(status);

    CREATE TABLE IF NOT EXISTS knowledge_review_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      intent TEXT CHECK(intent IN ('refund', 'order', 'technical', 'general')),
      intent_conf REAL,
      retrieval_snapshot TEXT NOT NULL DEFAULT '[]',
      trigger_reason TEXT NOT NULL CHECK(trigger_reason IN ('no_match', 'low_retrieval_score', 'negative_feedback')),
      rating INTEGER CHECK(rating >= 1 AND rating <= 5),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'converted', 'dismissed')),
      linked_faq_id TEXT REFERENCES faq_entries(id),
      dismiss_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_review_user_message
      ON knowledge_review_items(user_message_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_review_status_created
      ON knowledge_review_items(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_review_trigger_reason
      ON knowledge_review_items(trigger_reason);
    CREATE INDEX IF NOT EXISTS idx_knowledge_review_session_id
      ON knowledge_review_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_review_linked_faq
      ON knowledge_review_items(linked_faq_id);

    CREATE TABLE IF NOT EXISTS model_configs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);

  // v0.2.6 security migration: model credentials are environment-injected only.
  // Delete legacy plaintext overrides without reading or logging their values.
  database.prepare(
    "DELETE FROM model_configs WHERE key IN ('llmApiKey', 'embedApiKey')",
  ).run();

  ensureColumn(database, 'messages', 'reply_to_message_id', 'TEXT REFERENCES messages(id)');
  ensureColumn(database, 'messages', 'retrieval_snapshot', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'faq_entries', 'embedding_profile', 'TEXT');
  ensureColumn(database, 'document_chunks', 'embedding_profile', 'TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id)');
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
