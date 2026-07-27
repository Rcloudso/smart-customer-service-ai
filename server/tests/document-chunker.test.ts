import assert from 'node:assert/strict';
import {
  DOCUMENT_CHUNKER_VERSION,
  semanticChunk,
  semanticChunkPlan,
} from '../ai/document-chunker';

async function testSemanticBreaksAndBatchEmbedding(): Promise<void> {
  const calls: string[][] = [];
  const embedTexts = async (texts: string[]): Promise<number[][]> => {
    calls.push(texts);
    return texts.map((text) => text.includes('退款') ? [1, 0] : [0, 1]);
  };
  const units = [
    { content: `退款规则。${'退款申请需要订单号。'.repeat(18)}`, title: '退款' },
    { content: `退款时效。${'款项会原路返回。'.repeat(18)}`, title: '退款' },
    { content: `物流规则。${'包裹发出后可查询轨迹。'.repeat(18)}`, title: '物流' },
    { content: `物流时效。${'通常三个工作日送达。'.repeat(18)}`, title: '物流' },
  ];

  const chunks = await semanticChunk(units, embedTexts, '客服政策.md');

  assert.equal(chunks.length, 2, 'abrupt topics should form separate natural chunks');
  assert.match(chunks[0].content, /退款规则/);
  assert.doesNotMatch(chunks[0].content, /物流规则/);
  assert.match(chunks[1].content, /物流规则/);
  assert.equal(calls.length, 2, 'unit and final chunk embeddings should each be batched');
  assert.equal(calls[0].length, 4);
  assert.equal(calls[1].length, 2);
  assert.ok(calls[1].every((text) => text.includes('Document: 客服政策.md')));
  assert.ok(calls[1].some((text) => text.includes('Section: 退款')));
  assert.ok(chunks.every((chunk) => chunk.content.length <= 1_200));
}

async function testLongUnitsSplitBeforeEmbedding(): Promise<void> {
  const calls: string[][] = [];
  await semanticChunk([
    { content: '第一主题句。'.repeat(140) + '第二主题句。'.repeat(140), title: '长段落' },
  ], async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  });
  assert.ok(calls[0].length > 1, 'long structure units should split before unit embeddings');
  assert.ok(calls[0].every((text) => text.length <= 1_200), 'provider inputs must respect the hard chunk limit');
}

async function testStructureBoundariesAndProvenanceSurviveChunking(): Promise<void> {
  const plans = await semanticChunkPlan([
    {
      content: 'Refund policy details apply to every online order.',
      title: 'Refunds',
      headingPath: ['Policies', 'Refunds'],
      sourceBlockIds: ['block-000001', 'block-000002'],
      blockKind: 'paragraph',
    },
    {
      content: '- Provide an order number\n- Keep the original receipt',
      title: 'Refunds',
      headingPath: ['Policies', 'Refunds'],
      sourceBlockIds: ['block-000001', 'block-000003'],
      blockKind: 'list',
      structuralItems: ['- Provide an order number', '- Keep the original receipt'],
      structuralHeader: null,
    },
    {
      content: 'Method | Days\nCard | 7\nWallet | 2',
      title: 'Refunds',
      headingPath: ['Policies', 'Refunds'],
      sourceBlockIds: ['block-000001', 'block-000004'],
      blockKind: 'table',
      structuralHeader: 'Method | Days',
      structuralItems: ['Card | 7', 'Wallet | 2'],
    },
  ], async (texts) => texts.map(() => [1, 0]), 'policy.docx', {
    representationVersion: 'document-ir-v1',
    chunkerVersion: DOCUMENT_CHUNKER_VERSION,
  });

  assert.equal(plans.length, 3, 'paragraph, list and table must retain structure boundaries');
  assert.equal(plans[1].content, '- Provide an order number\n- Keep the original receipt');
  assert.equal(plans[2].content, 'Method | Days\nCard | 7\nWallet | 2');
  assert.deepEqual(plans[2].sourceBlockIds, ['block-000001', 'block-000004']);
  assert.deepEqual(plans[2].headingPath, ['Policies', 'Refunds']);
  assert.equal(plans[2].representationVersion, 'document-ir-v1');
  assert.equal(plans[2].chunkerVersion, DOCUMENT_CHUNKER_VERSION);
}

async function testCharacterBoundariesKeepExactProvenance(): Promise<void> {
  const plans = await semanticChunkPlan([
    {
      content: 'A'.repeat(800),
      title: 'First',
      pageStart: 1,
      pageEnd: 1,
      sourceBlockIds: ['block-000001'],
      blockKind: 'paragraph',
    },
    {
      content: 'B'.repeat(800),
      title: 'Second',
      pageStart: 2,
      pageEnd: 2,
      sourceBlockIds: ['block-000002'],
      blockKind: 'paragraph',
    },
  ], async (texts) => texts.map(() => [1, 0]));

  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].sourceBlockIds, ['block-000001']);
  assert.deepEqual(plans[1].sourceBlockIds, ['block-000002']);
  assert.deepEqual(
    plans.map((plan) => [plan.pageStart, plan.pageEnd]),
    [[1, 1], [2, 2]],
  );
}

Promise.all([
  testSemanticBreaksAndBatchEmbedding(),
  testLongUnitsSplitBeforeEmbedding(),
  testStructureBoundariesAndProvenanceSurviveChunking(),
  testCharacterBoundariesKeepExactProvenance(),
])
  .then(() => console.log('document chunker tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
