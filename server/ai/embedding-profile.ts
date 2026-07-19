import { createHash } from 'node:crypto';
import { config } from '../config';

export const FAQ_EMBEDDING_INPUT_VERSION = 'faq-question-answer-keywords-v1';
export const DOCUMENT_EMBEDDING_INPUT_VERSION = 'document-title-section-content-v1';

export function currentEmbeddingProfile(inputVersion: string): string {
  const apiBaseFingerprint = createHash('sha256')
    .update(config.embed.apiBase.trim())
    .digest('hex')
    .slice(0, 12);
  return [
    config.embed.provider,
    config.embed.model,
    apiBaseFingerprint,
    inputVersion,
  ].join(':');
}

export function buildDocumentEmbeddingText(params: {
  documentTitle: string;
  sectionTitle?: string | null;
  content: string;
}): string {
  return [
    `Document: ${params.documentTitle}`,
    params.sectionTitle ? `Section: ${params.sectionTitle}` : null,
    `Content: ${params.content}`,
  ].filter((value): value is string => Boolean(value)).join('\n');
}
