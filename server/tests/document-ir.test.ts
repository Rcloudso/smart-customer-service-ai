import assert from 'node:assert/strict';
import {
  DOCUMENT_IR_VERSION,
  DocumentIRValidationError,
  createStructuredDocument,
  validateDocumentIR,
} from '../ai/document-ir';

function testValidRepresentationKeepsStableOrderAndProvenance(): void {
  const representation = createStructuredDocument({
    source: {
      format: 'md',
      fileName: 'refund-policy.md',
      mimeType: 'text/markdown',
    },
    parser: { name: 'markdown', version: 'markdown-v2' },
    blocks: [
      {
        id: 'block-000001',
        kind: 'heading',
        order: 0,
        pageNumber: null,
        headingPath: ['Refunds'],
        confidence: null,
        layout: null,
        excluded: false,
        exclusionReason: null,
        level: 1,
        text: 'Refunds',
      },
      {
        id: 'block-000002',
        kind: 'paragraph',
        order: 1,
        pageNumber: null,
        headingPath: ['Refunds'],
        confidence: null,
        layout: null,
        excluded: false,
        exclusionReason: null,
        text: 'Apply within seven days.',
      },
    ],
  });

  assert.equal(representation.schemaVersion, DOCUMENT_IR_VERSION);
  assert.deepEqual(representation.blocks.map((block) => block.id), [
    'block-000001',
    'block-000002',
  ]);
  assert.deepEqual(representation.blocks[1].headingPath, ['Refunds']);
  assert.equal(representation.metrics.blockCount, 2);
  assert.equal(representation.metrics.includedCharacters, 31);
  assert.deepEqual(validateDocumentIR(JSON.parse(JSON.stringify(representation))), representation);
}

function testRepresentationRejectsAmbiguousOrderAndOversizedPayloads(): void {
  const valid = createStructuredDocument({
    source: { format: 'txt' },
    parser: { name: 'plain-text', version: 'plain-text-v2' },
    blocks: [
      {
        id: 'block-000001',
        kind: 'paragraph',
        order: 0,
        pageNumber: null,
        headingPath: [],
        confidence: null,
        layout: null,
        excluded: false,
        exclusionReason: null,
        text: 'Stable source text.',
      },
    ],
  });
  const duplicate = {
    ...valid,
    blocks: [
      valid.blocks[0],
      { ...valid.blocks[0], order: 1 },
    ],
  };
  assert.throws(
    () => validateDocumentIR(duplicate),
    (error) => error instanceof DocumentIRValidationError && error.failureCode === 'invalid_representation',
  );
  assert.throws(
    () => validateDocumentIR({
      ...valid,
      metrics: { ...valid.metrics, includedBlockCount: 999 },
    }),
    (error) => error instanceof DocumentIRValidationError && error.failureCode === 'invalid_representation',
  );

  const oversized = {
    ...valid,
    warnings: Array.from({ length: 2_100 }, (_, index) => ({
      code: `warning_${index}`,
      detail: 'x'.repeat(1_000),
      blockIds: [],
    })),
  };
  assert.throws(
    () => validateDocumentIR(oversized),
    (error) => error instanceof DocumentIRValidationError
      && error.failureCode === 'representation_too_large',
  );
}

try {
  testValidRepresentationKeepsStableOrderAndProvenance();
  testRepresentationRejectsAmbiguousOrderAndOversizedPayloads();
  console.log('document IR tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
