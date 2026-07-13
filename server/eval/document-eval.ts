import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { semanticChunk, SemanticUnit } from '../ai/document-chunker';
import { parseDocument } from '../ai/document-parser';
import type { KnowledgeAdapter, KnowledgeIndexItem } from '../ai/knowledge-retriever';
import type { RetrievalResult } from '../types/ai';

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
  chunkId: string;
  title: string;
  format: DocumentFormat;
  content: string;
  embedding: number[];
}

interface Metrics {
  top3: number;
  mrr: number;
  sourceDistribution: Record<string, number>;
  scores: number[];
  failures: Array<{ caseId: string; expected: string; returned: string[] }>;
}

const TOP_K = 3;

class EvalDocumentAdapter implements KnowledgeAdapter {
  readonly knowledgeType = 'document' as const;

  constructor(private readonly chunks: IndexedChunk[]) {}

  async loadIndexItems(): Promise<KnowledgeIndexItem[]> {
    return this.chunks.map((chunk) => ({
      id: `document:${chunk.chunkId}`,
      result: toResult(chunk, 0),
      embedding: chunk.embedding,
    }));
  }

  searchKeyword(query: string, limit: number): RetrievalResult[] {
    const normalizedQuery = normalize(query);
    return this.chunks
      .filter((chunk) => normalize(chunk.content).includes(normalizedQuery))
      .slice(0, limit)
      .map((chunk) => ({
        ...toResult(chunk, 0.95),
        source: 'keyword',
        keywordScore: 0.95,
      }));
  }
}

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

async function parseFixtures(documents: EvalDocument[]): Promise<Array<{ document: EvalDocument; units: SemanticUnit[] }>> {
  const parsed = [];
  for (const document of documents) {
    const result = await parseDocument(await createFormatBuffer(document), document.format);
    parsed.push({ document, units: result.units });
  }
  return parsed;
}

async function buildSemanticIndex(
  parsed: Array<{ document: EvalDocument; units: SemanticUnit[] }>,
): Promise<IndexedChunk[]> {
  const index: IndexedChunk[] = [];
  for (const { document, units } of parsed) {
    const chunks = await semanticChunk(units, embedTexts);
    for (const chunk of chunks) {
      index.push({
        documentId: document.id,
        chunkId: `${document.id}:${chunk.chunkIndex}`,
        title: document.title,
        format: document.format,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  }
  return index;
}

function buildStructureBaseline(
  parsed: Array<{ document: EvalDocument; units: SemanticUnit[] }>,
): IndexedChunk[] {
  return parsed.flatMap(({ document, units }) => units.map((unit, index) => ({
    documentId: document.id,
    chunkId: `${document.id}:structure:${index}`,
    title: document.title,
    format: document.format,
    content: unit.content,
    embedding: hashEmbedding(unit.content),
  })));
}

async function evaluate(cases: EvalCase[], index: IndexedChunk[]): Promise<Metrics> {
  process.env.NODE_ENV ||= 'test';
  process.env.JWT_SECRET ||= 'document-eval-secret';
  const [{ KnowledgeRetriever }, { InMemoryVectorStore }] = await Promise.all([
    import('../ai/knowledge-retriever'),
    import('../ai/vector-store'),
  ]);
  const retriever = new KnowledgeRetriever(
    new InMemoryVectorStore<KnowledgeIndexItem>(),
    embedTexts,
    [new EvalDocumentAdapter(index)],
  );
  let reciprocalRank = 0;
  let top3Hits = 0;
  const sourceDistribution: Record<string, number> = {};
  const scores: number[] = [];
  const failures: Metrics['failures'] = [];

  for (const testCase of cases) {
    const matches = await retriever.search(testCase.query, index.length, ['document']);
    const documentOrder = [...new Set(matches.map((match) => match.documentId as string))];
    const rankIndex = documentOrder.indexOf(testCase.expectedDocumentId);
    if (rankIndex >= 0) reciprocalRank += 1 / (rankIndex + 1);
    if (rankIndex >= 0 && rankIndex < TOP_K) top3Hits += 1;
    else failures.push({ caseId: testCase.id, expected: testCase.expectedDocumentId, returned: documentOrder.slice(0, TOP_K) });
    const top = matches[0];
    if (top) {
      const source = top.source ?? 'none';
      sourceDistribution[source] = (sourceDistribution[source] ?? 0) + 1;
      scores.push(top.similarity);
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

function toResult(chunk: IndexedChunk, similarity: number): RetrievalResult {
  return {
    knowledgeType: 'document',
    knowledgeId: chunk.chunkId,
    documentId: chunk.documentId,
    title: chunk.title,
    content: chunk.content,
    similarity,
  };
}

async function createFormatBuffer(document: EvalDocument): Promise<Buffer> {
  switch (document.format) {
    case 'txt':
      return Buffer.from(document.units.join('\n\n'));
    case 'md':
      return Buffer.from(document.units.map((unit, index) => `## Section ${index + 1}\n\n${unit}`).join('\n\n'));
    case 'pdf':
      return createSimplePdf(document.units.join(' '));
    case 'docx':
      return createDocx(document.units);
  }
}

function createSimplePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

async function createDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  const content = paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`).join('');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '');
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
  const parsed = await parseFixtures(fixture.documents);
  const semanticMetrics = await evaluate(fixture.cases, await buildSemanticIndex(parsed));
  const baselineMetrics = await evaluate(fixture.cases, buildStructureBaseline(parsed));

  console.log('Document retrieval evaluation');
  console.log(`Cases: ${fixture.cases.length}`);
  console.log(`Formats: ${[...formats].sort().join(', ')}`);
  printMetrics('semantic-v1', semanticMetrics);
  printMetrics('structure-baseline', baselineMetrics);

  if (semanticMetrics.top3 < 1 || semanticMetrics.top3 < baselineMetrics.top3 || semanticMetrics.mrr < baselineMetrics.mrr) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
