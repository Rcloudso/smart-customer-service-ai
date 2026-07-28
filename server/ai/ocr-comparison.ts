import { documentBlockText } from './document-ir';
import { OcrExtractionResult } from './ocr-contract';

const MAX_COMPARISON_CHARACTERS = 200_000;

export interface OcrComparison {
  blockCountDelta: number;
  warningCountDelta: number;
  textAgreement: number;
  structureAgreement: number;
}

export function compareOcrResults(
  authoritative: OcrExtractionResult,
  shadow: OcrExtractionResult,
): OcrComparison {
  const authoritativeStructure = authoritative.blocks.map((block) => (
    `${block.pageNumber}:${block.kind}`
  ));
  const shadowStructure = shadow.blocks.map((block) => (
    `${block.pageNumber}:${block.kind}`
  ));
  const structureMatches = authoritativeStructure.filter((value, index) => (
    shadowStructure[index] === value
  )).length;
  const structureDenominator = Math.max(
    authoritativeStructure.length,
    shadowStructure.length,
    1,
  );

  return {
    blockCountDelta: shadow.blocks.length - authoritative.blocks.length,
    warningCountDelta: shadow.warnings.length - authoritative.warnings.length,
    textAgreement: diceAgreement(
      extractionText(authoritative),
      extractionText(shadow),
    ),
    structureAgreement: structureMatches / structureDenominator,
  };
}

function extractionText(result: OcrExtractionResult): string {
  return normalizeText(result.blocks.map(documentBlockText).join('\n'));
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, MAX_COMPARISON_CHARACTERS);
}

function diceAgreement(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const leftCount = Math.max(left.length - 1, 1);
  const rightCount = Math.max(right.length - 1, 1);
  let overlap = 0;
  const remaining = new Map<string, number>();
  for (const value of bigrams(right)) {
    remaining.set(value, (remaining.get(value) ?? 0) + 1);
  }
  for (const value of bigrams(left)) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(value, count - 1);
    }
  }
  return (2 * overlap) / (leftCount + rightCount);
}

function* bigrams(value: string): Generator<string> {
  if (value.length < 2) {
    yield value;
    return;
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    yield value.slice(index, index + 2);
  }
}
