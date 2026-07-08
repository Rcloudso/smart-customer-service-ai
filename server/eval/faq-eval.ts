import fs from 'fs';
import path from 'path';
import type { FaqDebugMatch } from '../types/ai';

interface FaqEvalCase {
  id: string;
  query: string;
  expectedQuestions?: string[];
  shouldMatch?: boolean;
  maxAcceptableScore?: number;
  topK?: number;
}

interface FaqEvalCaseResult {
  id: string;
  query: string;
  expectedQuestions: string[];
  shouldMatch: boolean;
  topQuestion: string | null;
  topScore: number;
  top1Hit: boolean;
  topKHit: boolean;
  noMatchPass: boolean;
  source: string;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_NO_MATCH_MAX_SCORE = 0.9;
const MIN_TOP1_ACCURACY = 0.75;
const MIN_TOPK_RECALL = 0.9;

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-123';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'other';
process.env.LLM_API_KEY = process.env.LLM_API_KEY || '';
process.env.EMBED_API_KEY = process.env.EMBED_API_KEY || '';
process.env.DB_PATH = process.env.DB_PATH || './data/faq-eval.db';

function resolveDbPath(): string {
  return path.isAbsolute(process.env.DB_PATH ?? '')
    ? process.env.DB_PATH as string
    : path.resolve(process.cwd(), process.env.DB_PATH ?? './data/faq-eval.db');
}

function resetEvalDb(): void {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function loadCases(): FaqEvalCase[] {
  const casesPath = path.resolve(process.cwd(), 'eval/faq-cases.json');
  return JSON.parse(fs.readFileSync(casesPath, 'utf8')) as FaqEvalCase[];
}

function evaluateCase(testCase: FaqEvalCase, matches: FaqDebugMatch[]): FaqEvalCaseResult {
  const shouldMatch = testCase.shouldMatch !== false;
  const expectedQuestions = testCase.expectedQuestions ?? [];
  const top = matches[0] ?? null;
  const topScore = top?.bestScore ?? 0;
  const maxAcceptableScore = testCase.maxAcceptableScore ?? DEFAULT_NO_MATCH_MAX_SCORE;
  const top1Hit = shouldMatch && expectedQuestions.includes(top?.question ?? '');
  const topKHit = shouldMatch && matches.some((match) => expectedQuestions.includes(match.question));
  const noMatchPass = !shouldMatch && topScore < maxAcceptableScore;

  return {
    id: testCase.id,
    query: testCase.query,
    expectedQuestions,
    shouldMatch,
    topQuestion: top?.question ?? null,
    topScore,
    top1Hit,
    topKHit,
    noMatchPass,
    source: top?.source ?? 'none',
  };
}

async function main(): Promise<void> {
  resetEvalDb();

  const [{ seed }, { semanticSearch }, { closeDatabase }] = await Promise.all([
    import('../db/seed'),
    import('../ai/semantic-search'),
    import('../db'),
  ]);

  await seed();
  await semanticSearch.rebuildIndex();

  const cases = loadCases();
  const results: FaqEvalCaseResult[] = [];
  const sourceDistribution: Record<string, number> = {};

  for (const testCase of cases) {
    const topK = testCase.topK ?? DEFAULT_TOP_K;
    const debugResult = await semanticSearch.debugSearch(testCase.query, topK);
    const result = evaluateCase(testCase, debugResult.matches);
    results.push(result);
    sourceDistribution[result.source] = (sourceDistribution[result.source] ?? 0) + 1;
  }

  const matchCases = results.filter((result) => result.shouldMatch);
  const noMatchCases = results.filter((result) => !result.shouldMatch);
  const top1Accuracy = matchCases.filter((result) => result.top1Hit).length / Math.max(matchCases.length, 1);
  const topKRecall = matchCases.filter((result) => result.topKHit).length / Math.max(matchCases.length, 1);
  const noMatchAccuracy = noMatchCases.filter((result) => result.noMatchPass).length / Math.max(noMatchCases.length, 1);
  const failures = results.filter((result) =>
    result.shouldMatch ? !result.topKHit : !result.noMatchPass,
  );

  console.log('FAQ retrieval evaluation');
  console.log(`Cases: ${results.length}`);
  console.log(`Top1 accuracy: ${(top1Accuracy * 100).toFixed(1)}%`);
  console.log(`Top${DEFAULT_TOP_K} recall: ${(topKRecall * 100).toFixed(1)}%`);
  console.log(`No-match accuracy: ${(noMatchAccuracy * 100).toFixed(1)}%`);
  console.log(`Source distribution: ${JSON.stringify(sourceDistribution)}`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const failure of failures) {
      console.log(`- ${failure.id}: top="${failure.topQuestion}" score=${failure.topScore.toFixed(3)} expected=${failure.expectedQuestions.join(' | ') || 'no confident match'}`);
    }
  }

  closeDatabase();

  if (top1Accuracy < MIN_TOP1_ACCURACY || topKRecall < MIN_TOPK_RECALL || noMatchAccuracy < 1) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
