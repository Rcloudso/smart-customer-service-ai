import { KnowledgeRetrievalSnapshot } from '../types/domain';

const SOURCES = new Set(['vector', 'keyword', 'hybrid']);

function optionalScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseKnowledgeSnapshot(value: unknown): KnowledgeRetrievalSnapshot[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 3).flatMap((item): KnowledgeRetrievalSnapshot[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (
        (record.knowledgeType !== 'faq' && record.knowledgeType !== 'document') ||
        typeof record.knowledgeId !== 'string' ||
        typeof record.title !== 'string' ||
        typeof record.similarity !== 'number' ||
        !Number.isFinite(record.similarity)
      ) return [];
      if (record.source !== undefined && !SOURCES.has(String(record.source))) return [];
      const sourceBlockIds = Array.isArray(record.sourceBlockIds)
        ? record.sourceBlockIds.filter((item): item is string => (
            typeof item === 'string' && /^block-\d{6}$/.test(item)
          )).slice(0, 2_000)
        : undefined;
      const extractionEngine = record.extractionEngine === 'paddleocr_ppstructurev3'
        || record.extractionEngine === 'deepseek_ocr2'
        ? record.extractionEngine
        : undefined;
      return [{
        knowledgeType: record.knowledgeType,
        knowledgeId: record.knowledgeId,
        documentId: typeof record.documentId === 'string' ? record.documentId : undefined,
        title: record.title,
        source: record.source as KnowledgeRetrievalSnapshot['source'],
        similarity: record.similarity,
        keywordScore: optionalScore(record.keywordScore),
        vectorScore: optionalScore(record.vectorScore),
        chunkIndex: optionalScore(record.chunkIndex),
        pageStart: optionalScore(record.pageStart),
        pageEnd: optionalScore(record.pageEnd),
        sourceBlockIds,
        extractionJobId: typeof record.extractionJobId === 'string'
          && /^[0-9a-f-]{36}$/i.test(record.extractionJobId)
          ? record.extractionJobId
          : undefined,
        extractionEngine,
        extractionEngineVersion: typeof record.extractionEngineVersion === 'string'
          && record.extractionEngineVersion.length <= 80
          ? record.extractionEngineVersion
          : undefined,
      }];
    });
  } catch {
    return [];
  }
}
