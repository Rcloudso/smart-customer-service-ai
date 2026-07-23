import type { KnowledgeType, RetrievalResult } from '../types/ai';
import type { RetrievalPolicyConfig } from '../types/quality';

const SOURCE_PRIORITY: Record<NonNullable<RetrievalResult['source']>, number> = {
  hybrid: 3,
  vector: 2,
  keyword: 1,
};
const FAQ_RANK_PRIORITY_THRESHOLD = 0.65;
const DEFAULT_POLICY: RetrievalPolicyConfig = {
  directFaqThreshold: 0.8,
  generationEvidenceThreshold: 0.55,
  sourceDiversityRatio: 0.6,
  rerankerMode: 'none',
};

export function rankRetrievalResults(params: {
  query: string;
  candidates: RetrievalResult[];
  topK: number;
  knowledgeTypes: KnowledgeType[];
  policy?: RetrievalPolicyConfig;
}): RetrievalResult[] {
  const policy = params.policy ?? DEFAULT_POLICY;
  const baseRanked = [...params.candidates].sort(compareBase);
  const ranked = policy.rerankerMode === 'local_overlap_v1'
    ? rerankByLocalOverlap(params.query, baseRanked)
    : baseRanked;
  return selectDiverseResults(
    ranked,
    params.topK,
    params.knowledgeTypes,
    policy.sourceDiversityRatio,
  );
}

function compareBase(left: RetrievalResult, right: RetrievalResult): number {
  const directFaqDelta = Number(isFaqPriorityCandidate(right))
    - Number(isFaqPriorityCandidate(left));
  if (directFaqDelta !== 0) return directFaqDelta;
  const fusionDelta = (right.fusionScore ?? 0) - (left.fusionScore ?? 0);
  if (fusionDelta !== 0) return fusionDelta;
  const sourceDelta = SOURCE_PRIORITY[right.source ?? 'keyword']
    - SOURCE_PRIORITY[left.source ?? 'keyword'];
  if (sourceDelta !== 0) return sourceDelta;
  return resultKey(left).localeCompare(resultKey(right));
}

function rerankByLocalOverlap(
  query: string,
  baseRanked: RetrievalResult[],
): RetrievalResult[] {
  const queryTerms = terms(query);
  const fusionScores = baseRanked.map((result) => result.fusionScore ?? 0);
  const minimum = Math.min(...fusionScores);
  const maximum = Math.max(...fusionScores);
  const range = maximum - minimum;
  const baseOrder = new Map(baseRanked.map((result, index) => [resultKey(result), index]));

  return baseRanked
    .map((result) => {
      const normalizedFusion = range === 0
        ? 1
        : ((result.fusionScore ?? 0) - minimum) / range;
      const overlap = overlapRatio(queryTerms, terms(`${result.title} ${result.content}`));
      return {
        ...result,
        rerankScore: Number((normalizedFusion * 0.25 + overlap * 0.75).toFixed(6)),
      };
    })
    .sort((left, right) => {
      const directFaqDelta = Number(isFaqPriorityCandidate(right))
        - Number(isFaqPriorityCandidate(left));
      if (directFaqDelta !== 0) return directFaqDelta;
      const rerankDelta = (right.rerankScore ?? 0) - (left.rerankScore ?? 0);
      if (rerankDelta !== 0) return rerankDelta;
      return (baseOrder.get(resultKey(left)) ?? 0) - (baseOrder.get(resultKey(right)) ?? 0);
    });
}

function terms(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const token = match[0];
    if (/^[a-z0-9]+$/.test(token)) {
      result.add(token);
      continue;
    }
    const characters = Array.from(token);
    if (characters.length === 1) result.add(characters[0]);
    for (let index = 0; index < characters.length - 1; index += 1) {
      result.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return result;
}

function overlapRatio(query: Set<string>, candidate: Set<string>): number {
  if (query.size === 0) return 0;
  let matches = 0;
  for (const token of query) {
    if (candidate.has(token)) matches += 1;
  }
  return matches / query.size;
}

function selectDiverseResults(
  ranked: RetrievalResult[],
  topK: number,
  knowledgeTypes: KnowledgeType[],
  ratio: number,
): RetrievalResult[] {
  if (topK <= 1 || knowledgeTypes.length <= 1 || ranked.length <= 1) {
    return ranked.slice(0, topK);
  }
  const first = ranked[0];
  const selected = [first];
  const selectedKeys = new Set([resultKey(first)]);
  const relevance = (result: RetrievalResult): number => (
    result.rerankScore ?? result.fusionScore ?? 0
  );
  const floor = relevance(first) * ratio;

  for (const knowledgeType of knowledgeTypes) {
    if (selected.some((result) => result.knowledgeType === knowledgeType)) continue;
    const candidate = ranked.find((result) => (
      result.knowledgeType === knowledgeType && relevance(result) >= floor
    ));
    if (!candidate) continue;
    selected.push(candidate);
    selectedKeys.add(resultKey(candidate));
    if (selected.length >= topK) return selected;
  }

  for (const result of ranked) {
    const key = resultKey(result);
    if (selectedKeys.has(key)) continue;
    selected.push(result);
    selectedKeys.add(key);
    if (selected.length >= topK) break;
  }
  return selected;
}

function isFaqPriorityCandidate(result: RetrievalResult): boolean {
  return result.knowledgeType === 'faq'
    && (result.source === 'keyword' || result.source === 'hybrid')
    && (result.keywordScore ?? result.similarity) >= FAQ_RANK_PRIORITY_THRESHOLD;
}

function resultKey(result: RetrievalResult): string {
  return `${result.knowledgeType}:${result.knowledgeId}`;
}
