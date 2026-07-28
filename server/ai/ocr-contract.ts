import { z } from 'zod';
import {
  DocumentBlock,
  MAX_DOCUMENT_BLOCKS,
  documentBlockSchema,
} from './document-ir';

export const OCR_EXTRACTION_CONTRACT_VERSION = 'ocr-extraction-v1';
export const MAX_OCR_EXTRACTION_RESULT_BYTES = 4 * 1024 * 1024;
export const OCR_ENGINE_NAMES = [
  'paddleocr_ppstructurev3',
  'deepseek_ocr2',
] as const;

export type OcrEngineName = (typeof OCR_ENGINE_NAMES)[number];

const ocrWarningSchema = z.object({
  code: z.string().min(1).max(120),
  detail: z.string().max(2_000).optional(),
  blockIds: z.array(z.string().regex(/^block-\d{6}$/)).max(MAX_DOCUMENT_BLOCKS),
}).strict();

export const ocrExtractionResultSchema = z.object({
  contractVersion: z.literal(OCR_EXTRACTION_CONTRACT_VERSION),
  engine: z.object({
    name: z.enum(OCR_ENGINE_NAMES),
    version: z.string().min(1).max(80),
  }).strict(),
  blocks: z.array(documentBlockSchema).max(MAX_DOCUMENT_BLOCKS),
  warnings: z.array(ocrWarningSchema).max(MAX_DOCUMENT_BLOCKS),
  metrics: z.object({
    pageCount: z.number().int().nonnegative().max(2_000),
    blockCount: z.number().int().nonnegative().max(MAX_DOCUMENT_BLOCKS),
    elapsedMs: z.number().finite().nonnegative().max(30 * 60 * 1_000),
  }).strict(),
}).strict();

export type OcrExtractionResult = z.infer<typeof ocrExtractionResultSchema>;

export function validateOcrExtractionResult(input: unknown): OcrExtractionResult {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_OCR_EXTRACTION_RESULT_BYTES) {
    throw new OcrContractValidationError();
  }
  const parsed = ocrExtractionResultSchema.safeParse(input);
  if (!parsed.success) throw new OcrContractValidationError();
  if (parsed.data.metrics.blockCount !== parsed.data.blocks.length) {
    throw new OcrContractValidationError();
  }
  const ids = new Set<string>();
  const pages = new Set<number>();
  for (let index = 0; index < parsed.data.blocks.length; index += 1) {
    const block = parsed.data.blocks[index];
    if (block.order !== index || ids.has(block.id)) {
      throw new OcrContractValidationError();
    }
    if (block.pageNumber === null) throw new OcrContractValidationError();
    ids.add(block.id);
    pages.add(block.pageNumber);
  }
  if (
    parsed.data.metrics.pageCount < pages.size
    || [...pages].some((pageNumber) => pageNumber > parsed.data.metrics.pageCount)
  ) {
    throw new OcrContractValidationError();
  }
  if (parsed.data.warnings.some((warning) => (
    warning.blockIds.some((blockId) => !ids.has(blockId))
  ))) {
    throw new OcrContractValidationError();
  }
  return parsed.data;
}

export function validateOcrDraftBlocks(input: unknown): DocumentBlock[] {
  const parsed = z.array(documentBlockSchema).max(MAX_DOCUMENT_BLOCKS).safeParse(input);
  if (!parsed.success) throw new OcrContractValidationError();
  const ids = new Set<string>();
  for (let index = 0; index < parsed.data.length; index += 1) {
    const block = parsed.data[index];
    if (block.order !== index || ids.has(block.id)) {
      throw new OcrContractValidationError();
    }
    ids.add(block.id);
  }
  return parsed.data;
}

export class OcrContractValidationError extends Error {
  readonly failureCode = 'invalid_ocr_result';

  constructor() {
    super('invalid_ocr_result');
  }
}
