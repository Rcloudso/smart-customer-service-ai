import assert from 'node:assert/strict';
import {
  evaluateOcrCases,
  loadOcrEvaluationCases,
} from '../eval/ocr-evaluator';

try {
  const report = evaluateOcrCases(loadOcrEvaluationCases());
  assert.equal(report.total, 6);
  assert.equal(report.acceptedCaseCount, 5);
  assert.equal(report.pageCountAccuracy, 1);
  assert.equal(report.tableCellAccuracy, 1);
  assert.equal(report.lowQualityDetectionAccuracy, 1);
  assert.ok(report.averageCharacterErrorRate <= 0.08);
  assert.ok(report.blockKindAccuracy >= 0.9);
  assert.equal(report.passed, true);
  console.log('OCR evaluator tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
