export interface SemanticUnit {
  content: string;
  title?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
}

export interface SemanticChunk {
  chunkIndex: number;
  content: string;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  characterCount: number;
  embedding: number[];
}

const MAX_UNITS = 2_000;
const MAX_CHUNKS = 300;
const MIN_NATURAL_CHUNK = 200;
const MAX_CHUNK_CHARACTERS = 1_200;
const HARD_SPLIT_OVERLAP = 100;

interface Group {
  units: SemanticUnit[];
  start: number;
  end: number;
}

export async function semanticChunk(
  inputUnits: SemanticUnit[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
  documentTitle: string = '',
): Promise<SemanticChunk[]> {
  const units = inputUnits
    .map((unit) => ({ ...unit, content: normalizeText(unit.content) }))
    .filter((unit) => unit.content.length > 0)
    .flatMap(splitLongUnit);
  if (units.length === 0) throw new ChunkingError('empty_content');
  if (units.length > MAX_UNITS) throw new ChunkingError('too_many_units');

  const unitEmbeddings = await embedTexts(units.map((unit) => unit.content));
  assertEmbeddingBatch(unitEmbeddings, units.length);
  const dissimilarities = unitEmbeddings.slice(0, -1).map((embedding, index) => (
    1 - cosineSimilarity(embedding, unitEmbeddings[index + 1])
  ));
  const threshold = percentile(dissimilarities, 0.9);
  const groups = formNaturalGroups(units, dissimilarities, threshold);
  mergeShortGroups(groups, dissimilarities);

  const chunksWithoutEmbeddings = groups.flatMap((group) => {
    const content = group.units.map((unit) => unit.content).join('\n\n');
    const parts = hardSplit(content);
    const first = group.units[0];
    const last = group.units[group.units.length - 1];
    return parts.map((part) => ({
      content: part,
      title: first.title ?? null,
      pageStart: first.pageStart ?? null,
      pageEnd: last.pageEnd ?? last.pageStart ?? null,
    }));
  });
  if (chunksWithoutEmbeddings.length > MAX_CHUNKS) throw new ChunkingError('too_many_chunks');

  const chunkEmbeddings = await embedTexts(chunksWithoutEmbeddings.map((chunk) => (
    buildDocumentEmbeddingText({
      documentTitle,
      sectionTitle: chunk.title,
      content: chunk.content,
    })
  )));
  assertEmbeddingBatch(chunkEmbeddings, chunksWithoutEmbeddings.length);
  return chunksWithoutEmbeddings.map((chunk, index) => ({
    chunkIndex: index,
    ...chunk,
    characterCount: chunk.content.length,
    embedding: chunkEmbeddings[index],
  }));
}

function formNaturalGroups(
  units: SemanticUnit[],
  dissimilarities: number[],
  threshold: number,
): Group[] {
  const groups: Group[] = [];
  let start = 0;
  for (let index = 0; index < units.length - 1; index += 1) {
    if (dissimilarities[index] >= threshold && dissimilarities[index] > 0) {
      groups.push({ units: units.slice(start, index + 1), start, end: index });
      start = index + 1;
    }
  }
  groups.push({ units: units.slice(start), start, end: units.length - 1 });
  return groups;
}

function mergeShortGroups(groups: Group[], dissimilarities: number[]): void {
  let index = 0;
  while (groups.length > 1 && index < groups.length) {
    const group = groups[index];
    const length = group.units.map((unit) => unit.content).join('\n\n').length;
    if (length >= MIN_NATURAL_CHUNK) {
      index += 1;
      continue;
    }

    const previous = groups[index - 1];
    const next = groups[index + 1];
    const previousDistance = previous ? dissimilarities[group.start - 1] : Number.POSITIVE_INFINITY;
    const nextDistance = next ? dissimilarities[group.end] : Number.POSITIVE_INFINITY;
    const targetIndex = previousDistance <= nextDistance ? index - 1 : index + 1;
    const target = groups[targetIndex];
    const combinedUnits = targetIndex < index
      ? [...target.units, ...group.units]
      : [...group.units, ...target.units];
    const combinedLength = combinedUnits.map((unit) => unit.content).join('\n\n').length;
    if (combinedLength > MAX_CHUNK_CHARACTERS) {
      index += 1;
      continue;
    }
    const merged: Group = {
      units: combinedUnits,
      start: Math.min(target.start, group.start),
      end: Math.max(target.end, group.end),
    };
    groups.splice(Math.min(index, targetIndex), 2, merged);
    index = Math.max(0, Math.min(index, targetIndex) - 1);
  }
}

function hardSplit(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARACTERS) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const maximumEnd = Math.min(text.length, start + MAX_CHUNK_CHARACTERS);
    let end = maximumEnd;
    if (maximumEnd < text.length) {
      const candidate = text.slice(start, maximumEnd);
      const boundary = Math.max(
        candidate.lastIndexOf('\n'),
        candidate.lastIndexOf('。'),
        candidate.lastIndexOf('！'),
        candidate.lastIndexOf('？'),
        candidate.lastIndexOf('. '),
        candidate.lastIndexOf('! '),
        candidate.lastIndexOf('? '),
      );
      if (boundary >= Math.floor(MAX_CHUNK_CHARACTERS * 0.6)) end = start + boundary + 1;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - HARD_SPLIT_OVERLAP);
  }
  return parts.filter(Boolean);
}

function splitLongUnit(unit: SemanticUnit): SemanticUnit[] {
  if (unit.content.length <= MAX_CHUNK_CHARACTERS) return [unit];
  const sentences = unit.content.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [unit.content];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > MAX_CHUNK_CHARACTERS) {
      if (current) parts.push(current.trim());
      parts.push(...hardSplit(sentence));
      current = '';
      continue;
    }
    if (current && current.length + sentence.length > MAX_CHUNK_CHARACTERS) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((content) => ({ ...unit, content }));
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function assertEmbeddingBatch(embeddings: number[][], expectedLength: number): void {
  if (embeddings.length !== expectedLength || embeddings.some((embedding) => embedding.length === 0)) {
    throw new ChunkingError('embedding_failed');
  }
}

export class ChunkingError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}
import { buildDocumentEmbeddingText } from './embedding-profile';
