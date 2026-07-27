import assert from 'node:assert/strict';
import { cleanStructuredDocument, evaluateDocumentQuality } from '../ai/document-cleaner';
import { createStructuredDocument } from '../ai/document-ir';

function paragraph(
  order: number,
  text: string,
  pageNumber: number | null = null,
) {
  return {
    id: `block-${String(order + 1).padStart(6, '0')}`,
    kind: 'paragraph' as const,
    order,
    pageNumber,
    headingPath: [],
    confidence: null,
    layout: null,
    excluded: false,
    exclusionReason: null,
    text,
  };
}

function testDeterministicCleaningAndQualityDecisions(): void {
  const dirty = createStructuredDocument({
    source: { format: 'txt' },
    parser: { name: 'plain-text', version: 'plain-text-v2' },
    blocks: [
      paragraph(0, '  Refund\u0007 policy\r\n\r\n\r\nApply in seven days.  '),
      paragraph(1, ' \t '),
    ],
  });
  const cleaned = cleanStructuredDocument(dirty);
  assert.equal(cleaned.blocks[0].kind, 'paragraph');
  if (cleaned.blocks[0].kind === 'paragraph') {
    assert.equal(cleaned.blocks[0].text, 'Refund policy\n\nApply in seven days.');
  }
  assert.equal(cleaned.blocks[1].excluded, true);
  assert.equal(cleaned.blocks[1].exclusionReason, 'empty_after_cleaning');
  assert.equal(evaluateDocumentQuality(cleaned).decision, 'ready');

  const nearEmpty = cleanStructuredDocument(createStructuredDocument({
    source: { format: 'md' },
    parser: { name: 'markdown', version: 'markdown-v2' },
    blocks: [paragraph(0, 'Short')],
  }));
  assert.deepEqual(evaluateDocumentQuality(nearEmpty), {
    decision: 'review_required',
    reasons: ['near_empty_content'],
  });

  const empty = cleanStructuredDocument(createStructuredDocument({
    source: { format: 'txt' },
    parser: { name: 'plain-text', version: 'plain-text-v2' },
    blocks: [paragraph(0, '\u0007')],
  }));
  assert.deepEqual(evaluateDocumentQuality(empty), {
    decision: 'rejected',
    reasons: ['empty_content'],
  });
}

function testScanOnlyContentRequiresReview(): void {
  const scan = createStructuredDocument({
    source: { format: 'pdf' },
    parser: { name: 'pdf-parse', version: 'pdf-text-v2' },
    blocks: [{
      id: 'block-000001',
      kind: 'image_ref',
      order: 0,
      pageNumber: 1,
      headingPath: [],
      confidence: null,
      layout: null,
      excluded: false,
      exclusionReason: null,
      relationshipId: null,
      contentType: 'application/pdf',
      altText: null,
      requiresVisualProcessing: true,
    }],
    warnings: [{ code: 'ocr_required', blockIds: ['block-000001'] }],
  });
  assert.deepEqual(evaluateDocumentQuality(cleanStructuredDocument(scan)), {
    decision: 'review_required',
    reasons: ['ocr_required'],
  });

  const imageOnlyDocx = createStructuredDocument({
    source: { format: 'docx' },
    parser: { name: 'docx-ooxml', version: 'docx-ooxml-v2' },
    blocks: [{
      id: 'block-000001',
      kind: 'image_ref',
      order: 0,
      pageNumber: null,
      headingPath: [],
      confidence: null,
      layout: null,
      excluded: false,
      exclusionReason: null,
      relationshipId: 'rId1',
      contentType: 'image/png',
      altText: 'A very long descriptive label that must not be treated as extracted document text.',
      requiresVisualProcessing: true,
    }],
    warnings: [{ code: 'visual_processing_required', blockIds: ['block-000001'] }],
  });
  assert.equal(imageOnlyDocx.metrics.includedCharacters, 0);
  assert.deepEqual(evaluateDocumentQuality(cleanStructuredDocument(imageOnlyDocx)), {
    decision: 'review_required',
    reasons: ['visual_processing_required'],
  });
}

function testRepeatedPdfFurnitureIsExcludedOnlyWithStrongEvidence(): void {
  const representation = createStructuredDocument({
    source: { format: 'pdf' },
    parser: { name: 'pdf-parse', version: 'pdf-text-v2' },
    blocks: [
      paragraph(0, 'Company policy', 1),
      paragraph(1, 'Page one has meaningful refund guidance.', 1),
      paragraph(2, 'Company policy', 2),
      paragraph(3, 'Page two has meaningful shipping guidance.', 2),
      paragraph(4, 'Company policy', 3),
      paragraph(5, 'Page three has meaningful warranty guidance.', 3),
    ],
  });
  const cleaned = cleanStructuredDocument(representation);
  assert.deepEqual(
    cleaned.blocks.filter((block) => block.exclusionReason === 'repeated_header').map((block) => block.id),
    ['block-000001', 'block-000003', 'block-000005'],
  );
  assert.ok(cleaned.warnings.some((warning) => warning.code === 'repeated_header_removed'));

  const uncertain = cleanStructuredDocument(createStructuredDocument({
    source: { format: 'pdf' },
    parser: { name: 'pdf-parse', version: 'pdf-text-v2' },
    blocks: [
      paragraph(0, 'Company policy', 1),
      paragraph(1, 'First page.', 1),
      paragraph(2, 'Different header', 2),
      paragraph(3, 'Second page.', 2),
      paragraph(4, 'Company policy', 3),
      paragraph(5, 'Third page.', 3),
    ],
  }));
  assert.equal(uncertain.blocks.some((block) => block.exclusionReason === 'repeated_header'), false);
  assert.ok(uncertain.warnings.some(
    (warning) => warning.code === 'possible_repeated_header_retained',
  ));

  const onlyContent = cleanStructuredDocument(createStructuredDocument({
    source: { format: 'pdf' },
    parser: { name: 'pdf-parse', version: 'pdf-text-v2' },
    blocks: [
      paragraph(0, 'Same short policy sentence.', 1),
      paragraph(1, 'Same short policy sentence.', 2),
      paragraph(2, 'Same short policy sentence.', 3),
    ],
  }));
  assert.equal(
    onlyContent.blocks.some((block) => block.excluded),
    false,
    'the only Block on a page is content, not safely identifiable page furniture',
  );
}

try {
  testDeterministicCleaningAndQualityDecisions();
  testScanOnlyContentRequiresReview();
  testRepeatedPdfFurnitureIsExcludedOnlyWithStrongEvidence();
  console.log('document quality tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
