import { DocumentFormat } from '../types/domain';
import { StructuredDocument } from './document-ir';
import {
  DocumentParserError,
  getDocumentParserAdapter,
  structuredDocumentToSemanticUnits,
} from './document-parser-adapter';
import { SemanticUnit } from './document-chunker';

export interface DocumentParseContext {
  documentId?: string;
  sourceVersion?: number;
  fileName?: string;
  mimeType?: string;
  sha256?: string;
}

export interface ParsedDocument {
  representation: StructuredDocument;
  units: SemanticUnit[];
  characterCount: number;
}

export async function parseDocument(
  buffer: Buffer,
  format: DocumentFormat,
  context: DocumentParseContext = {},
): Promise<ParsedDocument> {
  const adapter = getDocumentParserAdapter(format);
  const representation = await adapter.parse(buffer, {
    sourceVersion: context.sourceVersion ?? 1,
    format,
    ...(context.documentId ? { documentId: context.documentId } : {}),
    ...(context.fileName ? { fileName: context.fileName } : {}),
    ...(context.mimeType ? { mimeType: context.mimeType } : {}),
    ...(context.sha256 ? { sha256: context.sha256 } : {}),
  });
  const units = structuredDocumentToSemanticUnits(representation);
  return {
    representation,
    units,
    characterCount: representation.metrics.includedCharacters,
  };
}

export { DocumentParserError };
