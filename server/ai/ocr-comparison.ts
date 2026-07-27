import { documentBlockText } from './document-ir';
import { OcrExtractionResult } from './ocr-contract';

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
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function diceAgreement(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let overlap = 0;
  const remaining = new Map<string, number>();
  for (const value of rightBigrams) {
    remaining.set(value, (remaining.get(value) ?? 0) + 1);
  }
  for (const value of leftBigrams) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(value, count - 1);
    }
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string): string[] {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => (
    value.slice(index, index + 2)
  ));
}
