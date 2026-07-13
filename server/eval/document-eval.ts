import fs from 'node:fs';
import path from 'node:path';
import { semanticChunk, SemanticUnit } from '../ai/document-chunker';

type DocumentFormat = 'txt' | 'md' | 'pdf' | 'docx';

interface EvalDocument {
  id: string;
  format: DocumentFormat;
  title: string;
  units: string[];
}

interface EvalCase {
  id: string;
  query: string;
  expectedDocumentId: string;
}

interface EvalFixture {
  documents: EvalDocument[];
  cases: EvalCase[];
}

interface IndexedChunk {
  documentId: string;
  title: string;
  format: DocumentFormat;
  content: string;
  embedding: number[];
}

interface RankedMatch extends IndexedChunk {
  score: number;
  source: 'vector' | 'hybrid';
}

interface Metrics {
  top3: number;
  mrr: number;
  sourceDistribution: Record<string, number>;
  scores: number[];
  failures: Array<{ caseId: string; expected: string; returned: string[] }>;
}

const TOP_K = 3;

function loadFixture(): EvalFixture {
  const filePath = path.resolve(process.cwd(), 'eval/document-cases.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvalFixture;
}

function hashEmbedding(text: string): number[] {
  const dimensions = 128;
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = normalize(text);
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    vector[code % dimensions] += 1;
    if (index + 1 < normalized.length) {
      const pair = code * 131 + normalized.charCodeAt(index + 1);
      vector[pair % dimensions] += 0.75;
    }
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  return texts.map(hashEmbedding);
}

async function buildSemanticIndex(documents: EvalDocument[]): Promise<IndexedChunk[]> {
  const index: IndexedChunk[] = [];
  for (const document of documents) {
    const units: SemanticUnit[] = document.units.map((content) => ({ content, title: document.title }));
    const chunks = await semanticChunk(units, embedTexts);
    for (const chunk of chunks) {
      index.push({
        documentId: document.id,
        title: document.title,
        format: document.format,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  }
  return index;
}

function buildStructureBaseline(documents: EvalDocument[]): IndexedChunk[] {
  return documents.flatMap((document) => document.units.map((content) => ({
    documentId: document.id,
    title: document.title,
    format: document.format,
    content,
    embedding: hashEmbedding(content),
  })));
}

function rank(query: string, index: IndexedChunk[]): RankedMatch[] {
  const queryEmbedding = hashEmbedding(query);
  const normalizedQuery = normalize(query);
  return index
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const exactTextMatch = normalize(chunk.content).includes(normalizedQuery);
      return {
        ...chunk,
        score: exactTextMatch ? Math.max(0.95, vectorScore) : vectorScore,
        source: exactTextMatch ? 'hybrid' as const : 'vector' as const,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function evaluate(cases: EvalCase[], index: IndexedChunk[]): Metrics {
  let reciprocalRank = 0;
  let top3Hits = 0;
  const sourceDistribution: Record<string, number> = {};
  const scores: number[] = [];
  const failures: Metrics['failures'] = [];

  for (const testCase of cases) {
    const matches = rank(testCase.query, index);
    const documentOrder = [...new Set(matches.map((match) => match.documentId))];
    const rankIndex = documentOrder.indexOf(testCase.expectedDocumentId);
    if (rankIndex >= 0) reciprocalRank += 1 / (rankIndex + 1);
    if (rankIndex >= 0 && rankIndex < TOP_K) top3Hits += 1;
    else failures.push({ caseId: testCase.id, expected: testCase.expectedDocumentId, returned: documentOrder.slice(0, TOP_K) });
    const top = matches[0];
    if (top) {
      sourceDistribution[top.source] = (sourceDistribution[top.source] ?? 0) + 1;
      scores.push(top.score);
    }
  }

  return {
    top3: top3Hits / Math.max(cases.length, 1),
    mrr: reciprocalRank / Math.max(cases.length, 1),
    sourceDistribution,
    scores,
    failures,
  };
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '');
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function scoreDistribution(scores: number[]): string {
  const ordered = [...scores].sort((left, right) => left - right);
  if (ordered.length === 0) return 'none';
  return JSON.stringify({
    min: Number(ordered[0].toFixed(3)),
    median: Number(ordered[Math.floor(ordered.length / 2)].toFixed(3)),
    max: Number(ordered[ordered.length - 1].toFixed(3)),
  });
}

function printMetrics(label: string, metrics: Metrics): void {
  console.log(`${label} Top3 recall: ${(metrics.top3 * 100).toFixed(1)}%`);
  console.log(`${label} MRR: ${metrics.mrr.toFixed(3)}`);
  console.log(`${label} score distribution: ${scoreDistribution(metrics.scores)}`);
  console.log(`${label} source distribution: ${JSON.stringify(metrics.sourceDistribution)}`);
  for (const failure of metrics.failures) {
    console.log(`- ${label} failure ${failure.caseId}: expected=${failure.expected} returned=${failure.returned.join(',')}`);
  }
}

async function main(): Promise<void> {
  const fixture = loadFixture();
  const formats = new Set(fixture.documents.map((document) => document.format));
  if (fixture.cases.length < 12 || formats.size !== 4) {
    throw new Error('Document evaluation requires at least 12 cases across txt, md, pdf and docx');
  }

  const semanticIndex = await buildSemanticIndex(fixture.documents);
  const baselineIndex = buildStructureBaseline(fixture.documents);
  const semanticMetrics = evaluate(fixture.cases, semanticIndex);
  const baselineMetrics = evaluate(fixture.cases, baselineIndex);

  console.log('Document retrieval evaluation');
  console.log(`Cases: ${fixture.cases.length}`);
  console.log(`Formats: ${[...formats].sort().join(', ')}`);
  printMetrics('semantic-v1', semanticMetrics);
  printMetrics('structure-baseline', baselineMetrics);

  if (
    semanticMetrics.top3 < 1
    || semanticMetrics.top3 < baselineMetrics.top3
    || semanticMetrics.mrr < baselineMetrics.mrr
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
