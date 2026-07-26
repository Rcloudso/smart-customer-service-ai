import { evaluateQualityCandidates } from './quality-evaluator';
import { QUALITY_BASELINE_CASES } from './quality-baseline';
import { DEFAULT_RETRIEVAL_POLICY } from '../services/quality-lab.service';
import { qualityFixtureCandidates } from '../services/quality-run.service';

const candidates = evaluateQualityCandidates({
  cases: QUALITY_BASELINE_CASES.map((testCase) => ({
    testCase: {
      ...testCase,
      versionId: 'quality-baseline-v1',
      createdAt: '2026-07-23T00:00:00.000Z',
    },
    candidates: qualityFixtureCandidates({
      ...testCase,
      versionId: 'quality-baseline-v1',
      createdAt: '2026-07-23T00:00:00.000Z',
    }),
    latencyMs: 0,
  })),
  policies: [
    DEFAULT_RETRIEVAL_POLICY,
    { ...DEFAULT_RETRIEVAL_POLICY, rerankerMode: 'local_overlap_v1' },
  ],
  embeddingCallCount: 0,
  estimatedTokenCount: 0,
});

console.log(JSON.stringify({
  dataset: 'quality-baseline-v1',
  cases: QUALITY_BASELINE_CASES.length,
  candidates: candidates.map((candidate) => ({
    policy: candidate.policy,
    metrics: candidate.metrics,
    recommended: candidate.recommended,
  })),
}, null, 2));

if (candidates.some((candidate) => candidate.metrics.unsafeAnswerCount > 0)) {
  console.error('Quality baseline failed: unsafe answer detected');
  process.exit(1);
}
if (candidates.some((candidate) => candidate.metrics.decisionAccuracy < 1)) {
  console.error('Quality baseline failed: decision accuracy regressed');
  process.exit(1);
}
if (candidates.some((candidate) => (
  candidate.metrics.recallAt3 < 1 || candidate.metrics.mrr < 1
))) {
  console.error('Quality baseline failed: retrieval quality regressed');
  process.exit(1);
}
