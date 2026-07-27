import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { documentBlockText } from '../ai/document-ir';
import {
  OcrExtractionResult,
  validateOcrExtractionResult,
} from '../ai/ocr-contract';

const fixtureSchema = z.array(z.object({
  id: z.string().min(1),
  sourceKind: z.enum([
    'zh_screenshot',
    'en_screenshot',
    'scanned_pdf',
    'table',
    'rotation_noise',
    'low_quality',
  ]),
  expectedText: z.string(),
  expectedKinds: z.array(z.string()),
  expectedPageCount: z.number().int().nonnegative(),
  expectedTableCells: z.array(z.string()).default([]),
  expectedLowQuality: z.boolean(),
  result: z.unknown(),
}).strict());

export interface OcrEvaluationCase {
  id: string;
  sourceKind: string;
  expectedText: string;
  expectedKinds: string[];
  expectedPageCount: number;
  expectedTableCells: string[];
  expectedLowQuality: boolean;
  result: OcrExtractionResult;
}
export interface OcrEvaluationReport {
  total: number;
  acceptedCaseCount: number;
  averageCharacterErrorRate: number;
  blockKindAccuracy: number;
  pageCountAccuracy: number;
  tableCellAccuracy: number;
  lowQualityDetectionAccuracy: number;
  passed: boolean;
  cases: Array<{
    id: string;
    characterErrorRate: number;
    blockKindAccuracy: number;
    pageCountCorrect: boolean;
    tableCellAccuracy: number | null;
    lowQualityDetected: boolean;
    expectedLowQuality: boolean;
  }>;
}

export function loadOcrEvaluationCases(
  filePath: string = path.resolve(process.cwd(), 'eval/ocr-cases.json'),
): OcrEvaluationCase[] {
  const parsed = fixtureSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  return parsed.map((item) => ({
    ...item,
    result: validateOcrExtractionResult(item.result),
  }));
}

export function evaluateOcrCases(cases: OcrEvaluationCase[]): OcrEvaluationReport {
  const evaluated = cases.map((item) => {
    const actualText = item.result.blocks.map(documentBlockText).join('\n');
    const kinds = item.result.blocks.map((block) => block.kind);
    const kindMatches = item.expectedKinds.filter((kind, index) => kinds[index] === kind).length;
    const actualTableCells = item.result.blocks.flatMap((block) => (
      block.kind === 'table' ? block.cells.map((cell) => normalize(cell.text)) : []
    ));
    const expectedTableCells = item.expectedTableCells.map(normalize);
    const tableMatches = expectedTableCells.filter((value) => actualTableCells.includes(value)).length;
    return {
      id: item.id,
      characterErrorRate: characterErrorRate(item.expectedText, actualText),
      blockKindAccuracy: item.expectedKinds.length === 0
        ? Number(kinds.length === 0)
        : kindMatches / Math.max(item.expectedKinds.length, kinds.length, 1),
      pageCountCorrect: item.result.metrics.pageCount === item.expectedPageCount,
      tableCellAccuracy: expectedTableCells.length === 0
        ? null
        : tableMatches / expectedTableCells.length,
      lowQualityDetected: detectsLowQuality(item.result),
      expectedLowQuality: item.expectedLowQuality,
    };
  });
  const accepted = evaluated.filter((item) => !item.expectedLowQuality);
  const tableCases = accepted.filter((item) => item.tableCellAccuracy !== null);
  const averageCharacterErrorRate = average(accepted.map((item) => item.characterErrorRate));
  const blockKindAccuracy = average(accepted.map((item) => item.blockKindAccuracy));
  const pageCountAccuracy = average(accepted.map((item) => Number(item.pageCountCorrect)));
  const tableCellAccuracy = tableCases.length === 0
    ? 1
    : average(tableCases.map((item) => item.tableCellAccuracy as number));
  const lowQualityDetectionAccuracy = average(evaluated.map((item) => (
    Number(item.lowQualityDetected === item.expectedLowQuality)
  )));
  return {
    total: evaluated.length,
    acceptedCaseCount: accepted.length,
    averageCharacterErrorRate,
    blockKindAccuracy,
    pageCountAccuracy,
    tableCellAccuracy,
    lowQualityDetectionAccuracy,
    passed: (
      evaluated.length >= 6
      && averageCharacterErrorRate <= 0.08
      && blockKindAccuracy >= 0.9
      && pageCountAccuracy === 1
      && tableCellAccuracy >= 0.95
      && lowQualityDetectionAccuracy === 1
    ),
    cases: evaluated,
  };
}

function detectsLowQuality(result: OcrExtractionResult): boolean {
  if (result.blocks.length === 0) return true;
  const confidences = result.blocks.flatMap((block) => (
    block.confidence === null ? [] : [block.confidence]
  ));
  return result.warnings.some((warning) => (
    warning.code === 'ocr_low_confidence' || warning.code === 'ocr_empty_page'
  )) || (confidences.length > 0 && average(confidences) < 0.6);
}

function characterErrorRate(expected: string, actual: string): number {
  const left = Array.from(normalize(expected));
  const right = Array.from(normalize(actual));
  if (left.length === 0) return right.length === 0 ? 0 : 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + Number(left[leftIndex] !== right[rightIndex]),
      ));
    }
    previous = current;
  }
  return previous[right.length] / left.length;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
