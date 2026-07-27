import { evaluateOcrCases, loadOcrEvaluationCases } from './ocr-evaluator';

try {
  const report = evaluateOcrCases(loadOcrEvaluationCases());
  console.log(`OCR cases: ${report.total}`);
  console.log(`Accepted cases: ${report.acceptedCaseCount}`);
  console.log(`Average CER: ${(report.averageCharacterErrorRate * 100).toFixed(2)}%`);
  console.log(`Block kind accuracy: ${(report.blockKindAccuracy * 100).toFixed(2)}%`);
  console.log(`Page count accuracy: ${(report.pageCountAccuracy * 100).toFixed(2)}%`);
  console.log(`Table cell accuracy: ${(report.tableCellAccuracy * 100).toFixed(2)}%`);
  console.log(`Low-quality detection: ${(report.lowQualityDetectionAccuracy * 100).toFixed(2)}%`);
  if (!report.passed) {
    console.error(JSON.stringify(report.cases.filter((item) => (
      item.characterErrorRate > 0.08
      || item.blockKindAccuracy < 0.9
      || !item.pageCountCorrect
      || item.lowQualityDetected !== item.expectedLowQuality
      || (item.tableCellAccuracy !== null && item.tableCellAccuracy < 0.95)
    )), null, 2));
    process.exit(1);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
