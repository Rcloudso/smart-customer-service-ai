import {
  DocumentBlock,
  DocumentWarning,
  StructuredDocument,
  documentBlockText,
  validateDocumentIR,
} from './document-ir';

export const DOCUMENT_CLEANER_VERSION = 'cleaner-v1';

export type DocumentQualityDecision = 'ready' | 'review_required' | 'rejected';
export type DocumentQualityReason =
  | 'empty_content'
  | 'near_empty_content'
  | 'ocr_required'
  | 'visual_processing_required'
  | 'unsupported_structure';

export interface DocumentQualityResult {
  decision: DocumentQualityDecision;
  reasons: DocumentQualityReason[];
}

export function cleanStructuredDocument(document: StructuredDocument): StructuredDocument {
  return cleanNormalizedStructuredDocument(normalizeStructuredDocument(document));
}

export function normalizeStructuredDocument(document: StructuredDocument): StructuredDocument {
  const blocks = document.blocks.map(normalizeBlock);
  const normalizedCharacters = blocks.reduce(
    (total, block) => total + documentBlockText(block).length,
    0,
  );
  return validateDocumentIR({
    ...document,
    blocks,
    metrics: {
      ...document.metrics,
      normalizedCharacters,
      includedCharacters: blocks.filter((block) => !block.excluded).reduce(
        (total, block) => total + documentBlockText(block).length,
        0,
      ),
    },
  });
}

export function cleanNormalizedStructuredDocument(document: StructuredDocument): StructuredDocument {
  const emptyMarked = document.blocks.map((block) => (
    documentBlockText(block).trim().length === 0 && block.kind !== 'image_ref'
      ? { ...block, excluded: true, exclusionReason: 'empty_after_cleaning' }
      : block
  )) as DocumentBlock[];
  const repeated = document.source.format === 'pdf'
    ? removeRepeatedPdfFurniture(emptyMarked)
    : { blocks: emptyMarked, warnings: [] as DocumentWarning[] };
  const duplicateWarnings = duplicateBlockWarnings(repeated.blocks);
  const warnings = mergeWarnings([
    ...document.warnings,
    ...repeated.warnings,
    ...duplicateWarnings,
  ]);
  const included = repeated.blocks.filter((block) => !block.excluded);
  return validateDocumentIR({
    ...document,
    blocks: repeated.blocks,
    warnings,
    metrics: {
      inputCharacters: document.metrics.inputCharacters,
      normalizedCharacters: document.metrics.normalizedCharacters,
      includedCharacters: included.reduce(
        (total, block) => total + documentBlockText(block).length,
        0,
      ),
      blockCount: repeated.blocks.length,
      includedBlockCount: included.length,
      excludedBlockCount: repeated.blocks.length - included.length,
      pageCount: new Set(repeated.blocks.flatMap((block) => (
        block.pageNumber === null ? [] : [block.pageNumber]
      ))).size,
    },
  });
}

export function evaluateDocumentQuality(document: StructuredDocument): DocumentQualityResult {
  const includedCharacters = document.metrics.includedCharacters;
  const warningCodes = new Set(document.warnings.map((warning) => warning.code));
  const hasImageReference = document.blocks.some((block) => (
    !block.excluded && block.kind === 'image_ref'
  ));
  if (includedCharacters === 0 && hasImageReference) {
    return {
      decision: 'review_required',
      reasons: [warningCodes.has('ocr_required') ? 'ocr_required' : 'visual_processing_required'],
    };
  }
  if (includedCharacters === 0) {
    return { decision: 'rejected', reasons: ['empty_content'] };
  }
  const reasons: DocumentQualityReason[] = [];
  if (includedCharacters < 20) reasons.push('near_empty_content');
  if (warningCodes.has('table_vertical_merge_limited')) reasons.push('unsupported_structure');
  return reasons.length > 0
    ? { decision: 'review_required', reasons: [...new Set(reasons)] }
    : { decision: 'ready', reasons: [] };
}

function normalizeBlock(block: DocumentBlock): DocumentBlock {
  switch (block.kind) {
    case 'text':
      return {
        ...block,
        text: block.variant === 'code' ? normalizeCode(block.text) : normalizeText(block.text),
      };
    case 'heading':
    case 'paragraph':
      return { ...block, text: normalizeText(block.text) };
    case 'list':
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, text: normalizeText(item.text) })),
      };
    case 'table':
      return {
        ...block,
        cells: block.cells.map((cell) => ({ ...cell, text: normalizeText(cell.text) })),
      };
    case 'key_value':
      return {
        ...block,
        pairs: block.pairs.map((pair) => ({
          key: normalizeText(pair.key),
          value: normalizeText(pair.value),
        })),
      };
    case 'image_ref':
      return {
        ...block,
        altText: block.altText === null ? null : normalizeText(block.altText),
      };
  }
}

function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeCode(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function removeRepeatedPdfFurniture(blocks: DocumentBlock[]): {
  blocks: DocumentBlock[];
  warnings: DocumentWarning[];
} {
  const pageNumbers = [...new Set(blocks.flatMap((block) => (
    block.pageNumber === null ? [] : [block.pageNumber]
  )))].sort((a, b) => a - b);
  const candidates = new Map<string, string[]>();
  for (const pageNumber of pageNumbers) {
    const pageBlocks = blocks.filter((block) => (
      block.pageNumber === pageNumber && !block.excluded && documentBlockText(block).trim()
    ));
    if (pageBlocks.length < 2) continue;
    const first = pageBlocks[0];
    const last = pageBlocks.at(-1);
    for (const [position, block] of [['header', first], ['footer', last]] as const) {
      if (!block) continue;
      const text = normalizeText(documentBlockText(block));
      if (!text || text.length > 200) continue;
      const key = `${position}\u0000${text}`;
      candidates.set(key, [...(candidates.get(key) ?? []), block.id]);
    }
  }
  const minimumCoverage = Math.ceil(pageNumbers.length * 0.6);
  const repeated = [...candidates.entries()].filter(([, ids]) => (
    pageNumbers.length >= 3 && ids.length >= 3 && ids.length >= minimumCoverage
  ));
  const repeatedKeys = new Set(repeated.map(([key]) => key));
  const uncertain = [...candidates.entries()].filter(([key, ids]) => (
    ids.length >= 2 && !repeatedKeys.has(key)
  ));
  const exclusions = new Map<string, 'repeated_header' | 'repeated_footer'>();
  const warnings: DocumentWarning[] = [];
  for (const [key, ids] of repeated) {
    const position = key.split('\u0000', 1)[0];
    const reason = position === 'header' ? 'repeated_header' : 'repeated_footer';
    for (const id of ids) exclusions.set(id, reason);
    warnings.push({
      code: `${reason}_removed`,
      blockIds: ids,
    });
  }
  for (const [key, ids] of uncertain) {
    const position = key.split('\u0000', 1)[0];
    warnings.push({
      code: position === 'header'
        ? 'possible_repeated_header_retained'
        : 'possible_repeated_footer_retained',
      blockIds: ids,
    });
  }
  return {
    blocks: blocks.map((block) => (
      exclusions.has(block.id)
        ? {
          ...block,
          excluded: true,
          exclusionReason: exclusions.get(block.id) as string,
        }
        : block
    )) as DocumentBlock[],
    warnings,
  };
}

function duplicateBlockWarnings(blocks: DocumentBlock[]): DocumentWarning[] {
  const groups = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.excluded || block.kind === 'image_ref') continue;
    const text = normalizeText(documentBlockText(block));
    if (!text) continue;
    groups.set(text, [...(groups.get(text) ?? []), block.id]);
  }
  const duplicates = [...groups.values()].filter((ids) => ids.length > 1).flat();
  return duplicates.length > 0
    ? [{ code: 'duplicate_blocks_detected', blockIds: duplicates }]
    : [];
}

function mergeWarnings(warnings: DocumentWarning[]): DocumentWarning[] {
  const merged = new Map<string, DocumentWarning>();
  for (const warning of warnings) {
    const current = merged.get(warning.code);
    merged.set(warning.code, {
      code: warning.code,
      ...(warning.detail ? { detail: warning.detail } : current?.detail ? { detail: current.detail } : {}),
      blockIds: [...new Set([...(current?.blockIds ?? []), ...warning.blockIds])],
    });
  }
  return [...merged.values()];
}
