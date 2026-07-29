import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export function knowledgeFingerprint(db: Database.Database): string {
  const rows = db.prepare(
    `SELECT 'faq' AS type, id, updated_at AS revision,
            COALESCE(embedding_profile, '') AS profile
     FROM faq_entries WHERE is_active = 1
     UNION ALL
     SELECT 'document' AS type, chunk.id, chunk.created_at AS revision,
            COALESCE(chunk.embedding_profile, '') AS profile
     FROM document_chunks chunk
     JOIN documents document ON document.id = chunk.document_id
     WHERE document.is_active = 1
       AND document.status = 'ready'
       AND document.index_status IN ('legacy', 'published')
     ORDER BY type, id`,
  ).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
