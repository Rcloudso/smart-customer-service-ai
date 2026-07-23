import assert from 'node:assert/strict';
import { rankRetrievalResults } from '../ai/retrieval-ranking';
import { evaluateQualityCandidates } from '../eval/quality-evaluator';
import { evaluateGrounding } from '../services/grounding-policy';
import type { RetrievalResult } from '../types/ai';
import { IntentCategory } from '../types/domain';
import type { QualityCase } from '../types/quality';

function result(
  params: Partial<RetrievalResult> & Pick<RetrievalResult, 'knowledgeId' | 'title' | 'content'>,
): RetrievalResult {
  return {
    knowledgeType: 'document',
    similarity: 0.6,
    source: 'vector',
    vectorScore: 0.6,
    fusionScore: 0.02,
    ...params,
  };
}

function testLocalOverlapRerankerIsDeterministic(): void {
  const unrelated = result({
    knowledgeId: 'unrelated',
    title: '会员权益',
    content: '会员到期后停止续费。',
    fusionScore: 0.03,
  });
  const relevant = result({
    knowledgeId: 'relevant',
    title: '偏远地区配送',
    content: '偏远地区配送需要五个工作日。',
    fusionScore: 0.02,
  });

  const ranked = rankRetrievalResults({
    query: '偏远地区配送多久',
    candidates: [unrelated, relevant],
    topK: 2,
    knowledgeTypes: ['document'],
    policy: {
      directFaqThreshold: 0.8,
      generationEvidenceThreshold: 0.55,
      sourceDiversityRatio: 0.6,
      rerankerMode: 'local_overlap_v1',
    },
  });

  assert.equal(ranked[0].knowledgeId, 'relevant');
  assert.ok((ranked[0].rerankScore ?? 0) > (ranked[1].rerankScore ?? 0));
  assert.deepEqual(
    rankRetrievalResults({
      query: '偏远地区配送多久',
      candidates: [unrelated, relevant],
      topK: 2,
      knowledgeTypes: ['document'],
      policy: {
        directFaqThreshold: 0.8,
        generationEvidenceThreshold: 0.55,
        sourceDiversityRatio: 0.6,
        rerankerMode: 'local_overlap_v1',
      },
    }).map((item) => item.knowledgeId),
    ranked.map((item) => item.knowledgeId),
  );
}

function testGroundingUsesCandidateThresholds(): void {
  const evidence = result({
    knowledgeId: 'weak-document',
    title: '配送说明',
    content: '配送通常需要五天。',
    similarity: 0.56,
    vectorScore: 0.56,
  });
  const accepted = evaluateGrounding({
    message: '配送多久',
    intent: IntentCategory.ORDER,
    faqMatches: [],
    retrievalResults: [evidence],
    explicitEscalation: false,
    policy: {
      directFaqThreshold: 0.8,
      generationEvidenceThreshold: 0.55,
      sourceDiversityRatio: 0.6,
      rerankerMode: 'none',
    },
  });
  const refused = evaluateGrounding({
    message: '配送多久',
    intent: IntentCategory.ORDER,
    faqMatches: [],
    retrievalResults: [evidence],
    explicitEscalation: false,
    policy: {
      directFaqThreshold: 0.8,
      generationEvidenceThreshold: 0.6,
      sourceDiversityRatio: 0.6,
      rerankerMode: 'none',
    },
  });
  assert.equal(accepted.answerMode, 'grounded_generation');
  assert.equal(refused.answerMode, 'refusal');
}

function testQualityMetricsPreferSafeLowerRefusalPolicy(): void {
  const cases: QualityCase[] = [
    {
      id: 'answerable',
      versionId: 'v1',
      query: '配送多久',
      expectedAnswerMode: 'grounded_generation',
      expectedGroundingStatus: 'sufficient',
      expectedSources: [{ knowledgeType: 'document', knowledgeId: 'shipping' }],
      language: 'zh',
      tags: [],
      createdAt: '2026-07-23T00:00:00.000Z',
    },
    {
      id: 'unsafe',
      versionId: 'v1',
      query: '帮我查询订单 10001 的状态',
      expectedAnswerMode: 'refusal',
      expectedGroundingStatus: 'high_risk',
      expectedSources: [],
      language: 'zh',
      tags: ['high-risk'],
      createdAt: '2026-07-23T00:00:00.000Z',
    },
  ];
  const shipping = result({
    knowledgeId: 'shipping-chunk-1',
    documentId: 'shipping',
    title: '配送时效',
    content: '配送需要五个工作日。',
    similarity: 0.56,
    vectorScore: 0.56,
  });
  const results = evaluateQualityCandidates({
    cases: cases.map((testCase) => ({
      testCase,
      candidates: [shipping],
      latencyMs: testCase.id === 'answerable' ? 10 : 20,
    })),
    policies: [
      {
        directFaqThreshold: 0.8,
        generationEvidenceThreshold: 0.55,
        sourceDiversityRatio: 0.6,
        rerankerMode: 'none',
      },
      {
        directFaqThreshold: 0.8,
        generationEvidenceThreshold: 0.6,
        sourceDiversityRatio: 0.6,
        rerankerMode: 'none',
      },
    ],
    embeddingCallCount: 1,
    estimatedTokenCount: 12,
  });
  assert.equal(results[0].metrics.unsafeAnswerCount, 0);
  assert.equal(results[0].metrics.overRefusalCount, 0);
  assert.equal(results[0].metrics.recallAt1, 1);
  assert.ok(results[0].metrics.p95LatencyMs >= 20);
  assert.equal(results[0].recommended, true);
  assert.equal(results[1].metrics.overRefusalCount, 1);
  assert.equal(results[1].recommended, false);
}

function main(): void {
  testLocalOverlapRerankerIsDeterministic();
  testGroundingUsesCandidateThresholds();
  testQualityMetricsPreferSafeLowerRefusalPolicy();
  console.log('quality evaluator tests passed');
}

main();
