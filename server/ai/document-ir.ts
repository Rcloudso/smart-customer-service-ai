import { z } from 'zod';
import { DocumentFormat } from '../types/domain';

export const DOCUMENT_IR_VERSION = 'document-ir-v1';
export const MAX_DOCUMENT_IR_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BLOCKS = 2_000;

const sourceSchema = z.object({
  documentId: z.string().uuid().optional(),
  sourceVersion: z.number().int().positive().default(1),
  format: z.enum(['txt', 'md', 'pdf', 'docx', 'png', 'jpeg', 'webp']),
  fileName: z.string().min(1).max(255).optional(),
  mimeType: z.string().min(1).max(255).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const parserSchema = z.object({
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(80),
}).strict();

const layoutSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();

const commonBlockShape = {
  id: z.string().regex(/^block-\d{6}$/),
  order: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive().nullable(),
  headingPath: z.array(z.string().max(500)).max(12),
  confidence: z.number().finite().min(0).max(1).nullable(),
  layout: layoutSchema.nullable(),
  excluded: z.boolean(),
  exclusionReason: z.string().max(120).nullable(),
};

const textBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('text'),
  text: z.string().max(200_000),
  variant: z.enum(['plain', 'code']).default('plain'),
}).strict();

const headingBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('heading'),
  level: z.number().int().min(1).max(6),
  text: z.string().max(10_000),
}).strict();

const paragraphBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('paragraph'),
  text: z.string().max(200_000),
}).strict();

const listBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    text: z.string().max(20_000),
  }).strict()).max(2_000),
}).strict();

const tableCellSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  columnIndex: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().max(1_000).default(1),
  columnSpan: z.number().int().positive().max(1_000).default(1),
  text: z.string().max(20_000),
  isHeader: z.boolean().default(false),
}).strict();

const tableBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('table'),
  rowCount: z.number().int().nonnegative().max(2_000),
  columnCount: z.number().int().nonnegative().max(500),
  cells: z.array(tableCellSchema).max(20_000),
}).strict();

const keyValueBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('key_value'),
  pairs: z.array(z.object({
    key: z.string().max(10_000),
    value: z.string().max(20_000),
  }).strict()).max(2_000),
}).strict();

const imageReferenceBlockSchema = z.object({
  ...commonBlockShape,
  kind: z.literal('image_ref'),
  relationshipId: z.string().max(255).nullable(),
  contentType: z.string().max(255).nullable(),
  altText: z.string().max(10_000).nullable(),
  requiresVisualProcessing: z.literal(true),
}).strict();

export const documentBlockSchema = z.discriminatedUnion('kind', [
  textBlockSchema,
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  tableBlockSchema,
  keyValueBlockSchema,
  imageReferenceBlockSchema,
]);

const warningSchema = z.object({
  code: z.string().min(1).max(120),
  detail: z.string().max(2_000).optional(),
  blockIds: z.array(z.string().regex(/^block-\d{6}$/)).max(MAX_DOCUMENT_BLOCKS),
}).strict();

const metricsSchema = z.object({
  inputCharacters: z.number().int().nonnegative(),
  normalizedCharacters: z.number().int().nonnegative(),
  includedCharacters: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
  includedBlockCount: z.number().int().nonnegative(),
  excludedBlockCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
}).strict();

export const structuredDocumentSchema = z.object({
  schemaVersion: z.literal(DOCUMENT_IR_VERSION),
  source: sourceSchema,
  parser: parserSchema,
  blocks: z.array(documentBlockSchema).max(MAX_DOCUMENT_BLOCKS),
  warnings: z.array(warningSchema).max(MAX_DOCUMENT_BLOCKS),
  metrics: metricsSchema,
}).strict();

export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type StructuredDocument = z.infer<typeof structuredDocumentSchema>;
export type DocumentWarning = StructuredDocument['warnings'][number];
export type DocumentIRSource = StructuredDocument['source'];
export type DocumentIRParser = StructuredDocument['parser'];

export function createStructuredDocument(params: {
  source: {
    documentId?: string;
    sourceVersion?: number;
    format: DocumentFormat;
    fileName?: string;
    mimeType?: string;
    sha256?: string;
  };
  parser: DocumentIRParser;
  blocks: DocumentBlock[];
  warnings?: DocumentWarning[];
}): StructuredDocument {
  return validateDocumentIR({
    schemaVersion: DOCUMENT_IR_VERSION,
    source: {
      sourceVersion: 1,
      ...params.source,
    },
    parser: params.parser,
    blocks: params.blocks,
    warnings: params.warnings ?? [],
    metrics: calculateDocumentMetrics(params.blocks),
  });
}

export function validateDocumentIR(input: unknown): StructuredDocument {
  const serializedBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (serializedBytes > MAX_DOCUMENT_IR_BYTES) {
    throw new DocumentIRValidationError('representation_too_large');
  }
  const parsed = structuredDocumentSchema.safeParse(input);
  if (!parsed.success) throw new DocumentIRValidationError('invalid_representation');
  const ids = new Set<string>();
  for (let index = 0; index < parsed.data.blocks.length; index += 1) {
    const block = parsed.data.blocks[index];
    if (block.order !== index || ids.has(block.id)) {
      throw new DocumentIRValidationError('invalid_representation');
    }
    ids.add(block.id);
  }
  const calculated = calculateDocumentMetrics(parsed.data.blocks);
  if (
    parsed.data.metrics.normalizedCharacters !== calculated.normalizedCharacters
    || parsed.data.metrics.includedCharacters !== calculated.includedCharacters
    || parsed.data.metrics.blockCount !== calculated.blockCount
    || parsed.data.metrics.includedBlockCount !== calculated.includedBlockCount
    || parsed.data.metrics.excludedBlockCount !== calculated.excludedBlockCount
    || parsed.data.metrics.pageCount !== calculated.pageCount
  ) {
    throw new DocumentIRValidationError('invalid_representation');
  }
  return parsed.data;
}

export function recalculateDocumentMetrics(document: StructuredDocument): StructuredDocument {
  return validateDocumentIR({
    ...document,
    metrics: calculateDocumentMetrics(document.blocks),
  });
}

export function documentBlockText(block: DocumentBlock): string {
  switch (block.kind) {
    case 'text':
    case 'heading':
    case 'paragraph':
      return block.text;
    case 'list':
      return block.items.map((item) => item.text).join('\n');
    case 'table':
      return block.cells.map((cell) => cell.text).join('\n');
    case 'key_value':
      return block.pairs.map((pair) => `${pair.key}: ${pair.value}`).join('\n');
    case 'image_ref':
      // Alt text describes the source image; it is not extracted document text.
      return '';
  }
}

function calculateDocumentMetrics(blocks: DocumentBlock[]): StructuredDocument['metrics'] {
  const inputCharacters = blocks.reduce((total, block) => total + documentBlockText(block).length, 0);
  const included = blocks.filter((block) => !block.excluded);
  const pages = new Set(blocks.flatMap((block) => (
    block.pageNumber === null ? [] : [block.pageNumber]
  )));
  return {
    inputCharacters,
    normalizedCharacters: inputCharacters,
    includedCharacters: included.reduce(
      (total, block) => total + documentBlockText(block).length,
      0,
    ),
    blockCount: blocks.length,
    includedBlockCount: included.length,
    excludedBlockCount: blocks.length - included.length,
    pageCount: pages.size,
  };
}

export class DocumentIRValidationError extends Error {
  constructor(public readonly failureCode: 'invalid_representation' | 'representation_too_large') {
    super(failureCode);
  }
}
