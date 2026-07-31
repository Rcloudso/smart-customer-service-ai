import Database from 'better-sqlite3';

export interface RetrievalTraceMessageDetail {
  id: string;
  content: string;
}

export interface RetrievalTraceKnowledgeDetail {
  knowledgeType: 'faq' | 'document';
  knowledgeId: string;
  title: string;
  content: string;
  available: true;
}

export class RetrievalTraceDetailRepo {
  constructor(private readonly db: Database.Database) {}

  findMessages(ids: string[]): RetrievalTraceMessageDetail[] {
    const unique = this.uniqueBounded(ids);
    if (unique.length === 0) return [];
    return this.db.prepare(`
      SELECT id, content FROM messages
      WHERE id IN (${this.placeholders(unique)})
    `).all(...unique) as RetrievalTraceMessageDetail[];
  }

  findFaqs(ids: string[]): RetrievalTraceKnowledgeDetail[] {
    const unique = this.uniqueBounded(ids);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT id, question, answer FROM faq_entries
      WHERE id IN (${this.placeholders(unique)})
    `).all(...unique) as Array<{ id: string; question: string; answer: string }>;
    return rows.map((row) => ({
      knowledgeType: 'faq',
      knowledgeId: row.id,
      title: row.question,
      content: row.answer,
      available: true,
    }));
  }

  findDocumentChunks(ids: string[]): RetrievalTraceKnowledgeDetail[] {
    const unique = this.uniqueBounded(ids);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT chunk.id, document.file_name, chunk.content
      FROM document_chunks chunk
      JOIN documents document ON document.id = chunk.document_id
      WHERE chunk.id IN (${this.placeholders(unique)})
    `).all(...unique) as Array<{ id: string; file_name: string; content: string }>;
    return rows.map((row) => ({
      knowledgeType: 'document',
      knowledgeId: row.id,
      title: row.file_name,
      content: row.content,
      available: true,
    }));
  }

  private uniqueBounded(ids: string[]): string[] {
    return [...new Set(ids.filter(Boolean))].slice(0, 160);
  }

  private placeholders(values: string[]): string {
    return values.map(() => '?').join(', ');
  }
}
