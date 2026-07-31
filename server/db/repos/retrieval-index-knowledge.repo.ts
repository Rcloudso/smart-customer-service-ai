import Database from 'better-sqlite3';
import type { VectorRecord } from '../../ai/vector-store';
import { ValidationError } from '../../utils/errors';

interface KnowledgeVectorRow {
  knowledge_type: 'faq' | 'document';
  id: string;
  revision: string;
  embedding_profile: string | null;
  embedding: string;
}

export interface RetrievalIndexKnowledgeMetadata {
  count: number;
  vectorDimension: number;
  embeddingProfiles: string[];
}

export interface RetrievalIndexKnowledgeCursor {
  knowledgeType: 'faq' | 'document';
  id: string;
}

export class RetrievalIndexKnowledgeRepo {
  constructor(private readonly db: Database.Database) {}

  inspect(batchSize: number): RetrievalIndexKnowledgeMetadata {
    let count = 0;
    let cursor: RetrievalIndexKnowledgeCursor | null = null;
    const dimensions = new Set<number>();
    const profiles = new Set<string>();

    while (true) {
      const page = this.readPage(cursor, batchSize);
      const { records } = page;
      if (records.length === 0) break;
      count += records.length;
      for (const record of records) {
        dimensions.add(record.embedding.length);
        profiles.add(record.embeddingProfile);
      }
      cursor = page.nextCursor;
    }

    if (count === 0) {
      throw new ValidationError('No active embedded knowledge to index');
    }
    if (dimensions.size !== 1) {
      throw new ValidationError('Active knowledge embeddings must use one vector dimension');
    }

    return {
      count,
      vectorDimension: [...dimensions][0],
      embeddingProfiles: [...profiles].sort(),
    };
  }

  readPage(
    cursor: RetrievalIndexKnowledgeCursor | null,
    limit: number,
  ): { records: VectorRecord[]; nextCursor: RetrievalIndexKnowledgeCursor | null } {
    const rows: KnowledgeVectorRow[] = [];
    if (!cursor || cursor.knowledgeType === 'faq') {
      rows.push(...this.readFaqRows(
        cursor?.knowledgeType === 'faq' ? cursor.id : '',
        limit,
      ));
    }
    if (rows.length < limit) {
      rows.push(...this.readDocumentRows(
        cursor?.knowledgeType === 'document' ? cursor.id : '',
        limit - rows.length,
      ));
    }

    const last = rows.at(-1);
    return {
      records: rows.map((row) => this.map(row)),
      nextCursor: last
        ? { knowledgeType: last.knowledge_type, id: last.id }
        : cursor,
    };
  }

  cursorAt(checkpoint: number): RetrievalIndexKnowledgeCursor | null {
    if (checkpoint <= 0) return null;
    const faqCount = (this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM faq_entries
      WHERE is_active = 1 AND embedding IS NOT NULL
    `).get() as { total: number }).total;
    if (checkpoint <= faqCount) {
      const row = this.db.prepare(`
        SELECT id FROM faq_entries
        WHERE is_active = 1 AND embedding IS NOT NULL
        ORDER BY id LIMIT 1 OFFSET ?
      `).get(checkpoint - 1) as { id: string } | undefined;
      if (!row) throw new ValidationError('Knowledge checkpoint is out of range');
      return { knowledgeType: 'faq', id: row.id };
    }
    const row = this.db.prepare(`
      SELECT chunk.id
      FROM document_chunks chunk
      JOIN documents document ON document.id = chunk.document_id
      WHERE document.is_active = 1
        AND document.status = 'ready'
        AND document.index_status IN ('legacy', 'published')
      ORDER BY chunk.id
      LIMIT 1 OFFSET ?
    `).get(checkpoint - faqCount - 1) as { id: string } | undefined;
    if (!row) throw new ValidationError('Knowledge checkpoint is out of range');
    return { knowledgeType: 'document', id: row.id };
  }

  private readFaqRows(afterId: string, limit: number): KnowledgeVectorRow[] {
    return this.db.prepare(`
      SELECT 'faq' AS knowledge_type, id, updated_at AS revision,
             embedding_profile, embedding
      FROM faq_entries
      WHERE is_active = 1 AND embedding IS NOT NULL AND id > ?
      ORDER BY id
      LIMIT ?
    `).all(afterId, limit) as KnowledgeVectorRow[];
  }

  private readDocumentRows(afterId: string, limit: number): KnowledgeVectorRow[] {
    return this.db.prepare(`
      SELECT 'document' AS knowledge_type, chunk.id, chunk.created_at AS revision,
             chunk.embedding_profile, chunk.embedding
      FROM document_chunks chunk
      JOIN documents document ON document.id = chunk.document_id
      WHERE document.is_active = 1
        AND document.status = 'ready'
        AND document.index_status IN ('legacy', 'published')
        AND chunk.id > ?
      ORDER BY chunk.id
      LIMIT ?
    `).all(afterId, limit) as KnowledgeVectorRow[];
  }

  private map(row: KnowledgeVectorRow): VectorRecord {
    let embedding: unknown;
    try {
      embedding = JSON.parse(row.embedding);
    } catch {
      throw new ValidationError('Knowledge embedding is malformed');
    }
    if (
      !Array.isArray(embedding)
      || embedding.length === 0
      || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      || !row.embedding_profile
    ) {
      throw new ValidationError('All active knowledge must have a valid embedding profile');
    }
    return {
      id: `${row.knowledge_type}:${row.id}`,
      knowledgeType: row.knowledge_type,
      revision: row.revision,
      embeddingProfile: row.embedding_profile,
      embedding,
    };
  }
}
