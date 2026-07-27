export interface SemanticUnit {
  content: string;
  title?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  sourceBlockIds?: string[];
  headingPath?: string[];
  blockKind?: string;
  structuralHeader?: string | null;
  structuralItems?: string[];
}

export interface SemanticChunk {
  chunkIndex: number;
  content: string;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  characterCount: number;
  embedding: number[];
  sourceBlockIds?: string[];
  headingPath?: string[];
  representationVersion?: string | null;
  chunkerVersion?: string | null;
}

export type SemanticChunkPlan = Omit<SemanticChunk, 'embedding'>;

export const DOCUMENT_CHUNKER_VERSION = 'structure-aware-v1';

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
  const plans = await semanticChunkPlan(inputUnits, embedTexts, documentTitle);
  const chunkEmbeddings = await embedTexts(plans.map((chunk) => (
    buildDocumentEmbeddingText({
      documentTitle,
      sectionTitle: chunk.title,
      content: chunk.content,
    })
  )));
  assertEmbeddingBatch(chunkEmbeddings, plans.length);
  return plans.map((chunk, index) => ({
    ...chunk,
    embedding: chunkEmbeddings[index],
  }));
}

export async function semanticChunkPlan(
  inputUnits: SemanticUnit[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
  _documentTitle: string = '',
  metadata: {
    representationVersion?: string | null;
    chunkerVersion?: string | null;
  } = {},
): Promise<SemanticChunkPlan[]> {
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

  const chunksWithoutEmbeddings: SemanticChunkPlan[] = groups.flatMap((group) => {
    return splitGroupUnits(group.units).map((partUnits) => {
      const content = partUnits.map((unit) => unit.content).join('\n\n');
      const first = partUnits[0];
      const last = partUnits[partUnits.length - 1];
      return {
        chunkIndex: 0,
        content,
        title: first.title ?? null,
        pageStart: first.pageStart ?? null,
        pageEnd: last.pageEnd ?? last.pageStart ?? null,
        characterCount: content.length,
        sourceBlockIds: [...new Set(partUnits.flatMap((unit) => unit.sourceBlockIds ?? []))],
        headingPath: first.headingPath ?? [],
        representationVersion: metadata.representationVersion ?? null,
        chunkerVersion: metadata.chunkerVersion ?? 'semantic-v1',
      };
    });
  });
  if (chunksWithoutEmbeddings.length > MAX_CHUNKS) throw new ChunkingError('too_many_chunks');
  return chunksWithoutEmbeddings.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}

function splitGroupUnits(units: SemanticUnit[]): SemanticUnit[][] {
  const groups: SemanticUnit[][] = [];
  let current: SemanticUnit[] = [];
  let currentLength = 0;
  for (const unit of units) {
    const separatorLength = current.length > 0 ? 2 : 0;
    if (current.length > 0
      && currentLength + separatorLength + unit.content.length > MAX_CHUNK_CHARACTERS) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(unit);
    currentLength += (current.length > 1 ? 2 : 0) + unit.content.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function formNaturalGroups(
  units: SemanticUnit[],
  dissimilarities: number[],
  threshold: number,
): Group[] {
  const groups: Group[] = [];
  let start = 0;
  for (let index = 0; index < units.length - 1; index += 1) {
    const current = units[index];
    const next = units[index + 1];
    const forcedBoundary = isStructuralUnit(current)
      || isStructuralUnit(next)
      || next.blockKind === 'heading';
    const keepHeadingWithChild = current.blockKind === 'heading';
    if (forcedBoundary || (!keepHeadingWithChild
      && dissimilarities[index] >= threshold
      && dissimilarities[index] > 0)) {
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
    if (group.units.some(isStructuralUnit)) {
      index += 1;
      continue;
    }
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
    if (!target || target.units.some(isStructuralUnit)) {
      index += 1;
      continue;
    }
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
  if (isStructuralUnit(unit)) return splitStructuralUnit(unit);
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

function splitStructuralUnit(unit: SemanticUnit): SemanticUnit[] {
  const items = unit.structuralItems ?? [];
  const header = unit.structuralHeader?.trim() ?? '';
  if (items.length === 0) throw new ChunkingError('structural_unit_too_large');
  if (items.some((item) => item.length + (header ? header.length + 1 : 0) > MAX_CHUNK_CHARACTERS)) {
    throw new ChunkingError('structural_unit_too_large');
  }
  const parts: string[] = [];
  let current = header;
  for (const item of items) {
    const candidate = current ? `${current}\n${item}` : item;
    if (candidate.length > MAX_CHUNK_CHARACTERS && current !== header) {
      parts.push(current);
      current = header ? `${header}\n${item}` : item;
    } else {
      current = candidate;
    }
  }
  if (current && current !== header) parts.push(current);
  return parts.map((content) => ({
    ...unit,
    content,
    structuralItems: undefined,
    structuralHeader: undefined,
  }));
}

function isStructuralUnit(unit: SemanticUnit): boolean {
  return unit.blockKind === 'list'
    || unit.blockKind === 'table'
    || unit.blockKind === 'key_value';
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
