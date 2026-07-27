import { getLLMClient } from '../ai/llm-client';
import { HttpOcrExtractor } from '../ai/ocr-extractor';
import { documentKnowledgeAdapter, knowledgeRetriever } from '../ai/knowledge-system';
import { config } from '../config';
import { getDatabase } from '../db';
import { DocumentService } from './document.service';
import { DocumentOcrScheduler } from './document-ocr-scheduler';

export const documentService = new DocumentService(getDatabase(), {
  uploadDir: config.documents.uploadDir,
  authoritativeOcr: config.ocr.serviceUrl
    ? new HttpOcrExtractor({
      baseUrl: config.ocr.serviceUrl,
      token: config.ocr.serviceToken,
      engine: 'paddleocr_ppstructurev3',
      engineVersion: config.ocr.engineVersion,
      timeoutMs: config.ocr.timeoutMs,
    })
    : undefined,
  shadowOcr: config.ocr.shadowServiceUrl
    ? new HttpOcrExtractor({
      baseUrl: config.ocr.shadowServiceUrl,
      token: config.ocr.shadowServiceToken,
      engine: 'deepseek_ocr2',
      engineVersion: config.ocr.shadowEngineVersion,
      timeoutMs: config.ocr.timeoutMs,
    })
    : undefined,
  ocrMode: config.ocr.backgroundEnabled ? 'queued' : 'inline',
  embedTexts: async (texts) => (await getLLMClient().embed(texts)).map((result) => result.embedding),
  publishChunks: (chunks, document) => {
    if (!document) throw new Error('Document metadata is required for index publication');
    knowledgeRetriever.replaceDocumentIndexItems(
      document.id,
      chunks.map((chunk) => documentKnowledgeAdapter.toIndexItem(chunk, document.fileName)),
    );
  },
  synchronizeIndex: async () => knowledgeRetriever.refreshSource('document'),
  removeDocumentFromIndex: async (_documentId, chunks) => {
    for (const chunk of chunks) {
      knowledgeRetriever.deleteIndexItem('document', `document:${chunk.id}`);
    }
  },
});

export const documentOcrScheduler = new DocumentOcrScheduler(
  documentService,
  config.ocr.pollIntervalMs,
);
