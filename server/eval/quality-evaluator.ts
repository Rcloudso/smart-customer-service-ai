import { createHash } from 'node:crypto';
import { rankRetrievalResults } from '../ai/retrieval-ranking';
import { evaluateGrounding } from '../services/grounding-policy';
import type { FaqMatch, RetrievalResult } from '../types/ai';
import { IntentCategory } from '../types/domain';
import type {
  QualityCandidateResult,
  QualityCase,
  QualityCaseResult,
  QualityBackendTarget,
  RetrievalPolicyConfig,
} from '../types/quality';

export interface RetrievedQualityCase {
  testCase: QualityCase;
  candidates: RetrievalResult[];
  latencyMs: number;
}

export function evaluateQualityCandidates(params: {
  cases: RetrievedQualityCase[];
  policies: RetrievalPolicyConfig[];
  embeddingCallCount: number;
  estimatedTokenCount: number;
  backendTarget?: QualityBackendTarget;
}): QualityCandidateResult[] {
  const backendTarget = params.backendTarget ?? { provider: 'memory' as const };
  const results: QualityCandidateResult[] = params.policies.map((policy) => {
    const candidateKey = qualityCandidateKey(backendTarget, policy);
    const caseResults = params.cases.map(({ testCase, candidates, latencyMs }) => {
      const started = performance.now();
      const result = evaluateCase(testCase, candidates, latencyMs, policy, candidateKey);
      return {
        ...result,
        latencyMs: Number((latencyMs + performance.now() - started).toFixed(3)),
      };
    });
    const answerable = params.cases.filter(
      ({ testCase }) => testCase.expectedGroundingStatus === 'sufficient',
    );
    let top1Hits = 0;
    let top3Hits = 0;
    let reciprocalRank = 0;
    const sourceDistribution: Record<string, number> = {};
    for (const caseResult of caseResults) {
      const topSource = caseResult.sources[0]?.source ?? 'none';
      sourceDistribution[topSource] = (sourceDistribution[topSource] ?? 0) + 1;
      const testCase = params.cases.find(({ testCase: item }) => item.id === caseResult.caseId)?.testCase;
      if (!testCase || testCase.expectedGroundingStatus !== 'sufficient') continue;
      const rank = caseResult.sources.findIndex((source) => (
        testCase.expectedSources.some((expected) => (
          expected.knowledgeType === source.knowledgeType
          && (
            expected.knowledgeId === source.knowledgeId
            || (
              expected.knowledgeType === 'document'
              && expected.knowledgeId === source.documentId
            )
          )
        ))
      ));
      if (rank === 0) top1Hits += 1;
      if (rank >= 0 && rank < 3) top3Hits += 1;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
    }
    const latency = percentileValues(caseResults.map((item) => item.latencyMs));
    const denominator = Math.max(answerable.length, 1);
    return {
      key: candidateKey,
      backendTarget,
      policy,
      recommended: false,
      cases: caseResults,
      metrics: {
        recallAt1: top1Hits / denominator,
        recallAt3: top3Hits / denominator,
        mrr: reciprocalRank / denominator,
        decisionAccuracy: caseResults.filter((item) => item.passed).length
          / Math.max(caseResults.length, 1),
        unsafeAnswerCount: caseResults.filter((item) => item.failureReason === 'unsafe_answer').length,
        overRefusalCount: caseResults.filter((item) => item.failureReason === 'over_refusal').length,
        sourceDistribution,
        p50LatencyMs: latency.p50,
        p95LatencyMs: latency.p95,
        failureCount: caseResults.filter((item) => !item.passed).length,
        embeddingCallCount: params.embeddingCallCount,
        estimatedTokenCount: params.estimatedTokenCount,
        estimatedCost: null,
      },
    };
  });
  const recommended = [...results].sort(compareCandidates)[0];
  if (recommended) recommended.recommended = true;
  return results;
}

export function policyKey(policy: RetrievalPolicyConfig): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export function qualityCandidateKey(
  target: QualityBackendTarget,
  policy: RetrievalPolicyConfig,
): string {
  const backend = target.provider === 'memory'
    ? 'memory'
    : `qdrant:${target.indexJobId}`;
  return `${backend}:${policyKey(policy)}`;
}

function evaluateCase(
  testCase: QualityCase,
  candidates: RetrievalResult[],
  latencyMs: number,
  policy: RetrievalPolicyConfig,
  candidateKey: string,
): QualityCaseResult {
  const ranked = rankRetrievalResults({
    query: testCase.query,
    candidates,
    topK: 3,
    knowledgeTypes: ['faq', 'document'],
    policy,
  });
  const faqMatches: FaqMatch[] = ranked
    .filter((result) => result.knowledgeType === 'faq')
    .map((result) => ({
      id: result.knowledgeId,
      question: result.title,
      answer: result.content,
      similarity: result.similarity,
      source: result.source,
      vectorScore: result.vectorScore,
      keywordScore: result.keywordScore,
      fusionScore: result.fusionScore,
      vectorRank: result.vectorRank,
      keywordRank: result.keywordRank,
    }));
  const decision = evaluateGrounding({
    message: testCase.query,
    intent: IntentCategory.GENERAL,
    faqMatches,
    retrievalResults: ranked,
    explicitEscalation: testCase.expectedGroundingStatus === 'escalated',
    policy,
  });
  const decisionMatches = decision.answerMode === testCase.expectedAnswerMode
    && decision.groundingStatus === testCase.expectedGroundingStatus;
  const expectedAnswer = testCase.expectedGroundingStatus === 'sufficient';
  const actualAnswer = decision.groundingStatus === 'sufficient';
  let failureReason: string | null = null;
  if (!expectedAnswer && actualAnswer) failureReason = 'unsafe_answer';
  else if (expectedAnswer && !actualAnswer) failureReason = 'over_refusal';
  else if (!decisionMatches) failureReason = 'decision_mismatch';
  return {
    caseId: testCase.id,
    candidateKey,
    actualAnswerMode: decision.answerMode,
    actualGroundingStatus: decision.groundingStatus,
    sources: decision.citations.map((result) => ({
      knowledgeType: result.knowledgeType,
      knowledgeId: result.knowledgeId,
      documentId: result.documentId,
      title: result.title,
      source: result.source,
      similarity: result.similarity,
      keywordScore: result.keywordScore,
      vectorScore: result.vectorScore,
      fusionScore: result.fusionScore,
      keywordRank: result.keywordRank,
      vectorRank: result.vectorRank,
      chunkIndex: result.chunkIndex,
      pageStart: result.pageStart,
      pageEnd: result.pageEnd,
    })),
    latencyMs,
    passed: failureReason === null,
    failureReason,
  };
}

function compareCandidates(
  left: QualityCandidateResult,
  right: QualityCandidateResult,
): number {
  return left.metrics.unsafeAnswerCount - right.metrics.unsafeAnswerCount
    || left.metrics.overRefusalCount - right.metrics.overRefusalCount
    || right.metrics.decisionAccuracy - left.metrics.decisionAccuracy
    || right.metrics.recallAt3 - left.metrics.recallAt3
    || right.metrics.mrr - left.metrics.mrr
    || left.metrics.p95LatencyMs - right.metrics.p95LatencyMs
    || left.key.localeCompare(right.key);
}

function percentileValues(values: number[]): { p50: number; p95: number } {
  if (values.length === 0) return { p50: 0, p95: 0 };
  const ordered = [...values].sort((left, right) => left - right);
  const at = (percentile: number): number => (
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1)]
  );
  return { p50: at(0.5), p95: at(0.95) };
}
