import { getLLMClient } from '../ai/llm-client';
import { knowledgeRetriever } from '../ai/knowledge-system';
import { config } from '../config';
import { getDatabase } from '../db';
import { DocumentService } from './document.service';

export const documentService = new DocumentService(getDatabase(), {
  uploadDir: config.documents.uploadDir,
  embedTexts: async (texts) => (await getLLMClient().embed(texts)).map((result) => result.embedding),
  publishChunks: async () => knowledgeRetriever.refreshSource('document'),
  synchronizeIndex: async () => knowledgeRetriever.refreshSource('document'),
  removeDocumentFromIndex: async (_documentId, chunks) => {
    for (const chunk of chunks) {
      knowledgeRetriever.deleteIndexItem('document', `document:${chunk.id}`);
    }
  },
});
