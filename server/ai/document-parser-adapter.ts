import { DOMParser } from '@xmldom/xmldom';
import JSZip, { JSZipObject } from 'jszip';
import { PDFParse } from 'pdf-parse';
import { DocumentFormat } from '../types/domain';
import {
  DocumentBlock,
  DocumentIRValidationError,
  DocumentIRSource,
  DocumentWarning,
  StructuredDocument,
  createStructuredDocument,
  documentBlockText,
} from './document-ir';
import { SemanticUnit } from './document-chunker';

const MAX_EXTRACTED_CHARACTERS = 200_000;
const MAX_PDF_PAGES = 2_000;
const MAX_PDF_VISUAL_INSPECTION_PAGES = 100;
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

export interface DocumentParserAdapter {
  readonly name: string;
  readonly version: string;
  parse(buffer: Buffer, source: DocumentIRSource): Promise<StructuredDocument>;
}

const adapters: Record<DocumentFormat, DocumentParserAdapter> = {
  txt: {
    name: 'plain-text',
    version: 'plain-text-v2',
    async parse(buffer, source) {
      const blocks = splitParagraphs(decodeUtf8(buffer)).map((text, index): DocumentBlock => ({
        ...baseBlock(index, []),
        kind: 'paragraph',
        text,
      }));
      return finish(this, source, blocks);
    },
  },
  md: {
    name: 'markdown',
    version: 'markdown-v2',
    async parse(buffer, source) {
      return finish(this, source, parseMarkdown(decodeUtf8(buffer)));
    },
  },
  pdf: {
    name: 'pdf-parse',
    version: 'pdf-text-v2',
    async parse(buffer, source) {
      return parsePdf(this, buffer, source);
    },
  },
  docx: {
    name: 'docx-ooxml',
    version: 'docx-ooxml-v2',
    async parse(buffer, source) {
      return parseDocx(this, buffer, source);
    },
  },
};

export function getDocumentParserAdapter(format: DocumentFormat): DocumentParserAdapter {
  return adapters[format];
}

export function structuredDocumentToSemanticUnits(document: StructuredDocument): SemanticUnit[] {
  const units: SemanticUnit[] = [];
  let activeHeadingIds: string[] = [];
  for (const block of document.blocks) {
    if (block.excluded || block.kind === 'image_ref') continue;
    if (block.kind === 'heading') {
      activeHeadingIds = activeHeadingIds.slice(0, block.level - 1);
      activeHeadingIds[block.level - 1] = block.id;
    }
    const content = renderBlockText(block);
    if (!content) continue;
    const structural = structuralParts(block);
    units.push({
      content,
      title: block.kind === 'heading'
        ? block.text
        : block.headingPath.at(-1) ?? null,
      pageStart: block.pageNumber,
      pageEnd: block.pageNumber,
      sourceBlockIds: [...new Set([...activeHeadingIds.filter(Boolean), block.id])],
      headingPath: block.headingPath,
      blockKind: block.kind,
      structuralHeader: structural?.header,
      structuralItems: structural?.items,
    });
  }
  return units;
}

function parseMarkdown(text: string): DocumentBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  const headingPath: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const nextBase = () => baseBlock(blocks.length, headingPath);
  const flushParagraph = () => {
    const content = paragraph.join('\n').trim();
    paragraph = [];
    if (!content) return;
    blocks.push({ ...nextBase(), kind: 'paragraph', text: content });
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({
      ...nextBase(),
      kind: 'list',
      ordered: listOrdered,
      items: listItems.map((item, ordinal) => ({ ordinal, text: item })),
    });
    listItems = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({
        ...nextBase(),
        kind: 'text',
        variant: 'code',
        text: code.join('\n'),
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const value = heading[2].trim();
      updateHeadingPath(headingPath, level, value);
      blocks.push({
        ...nextBase(),
        kind: 'heading',
        level,
        text: value,
      });
      continue;
    }

    const list = line.match(/^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const ordered = Boolean(list[1]);
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push(list[2].trim());
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

async function parsePdf(
  adapter: DocumentParserAdapter,
  buffer: Buffer,
  source: DocumentIRSource,
): Promise<StructuredDocument> {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new DocumentParserError('invalid_pdf');
  }
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    stopAtErrors: true,
    isEvalSupported: false,
    maxImageSize: 16_000_000,
  });
  try {
    const info = await parser.getInfo();
    if (info.total > MAX_PDF_PAGES) throw new DocumentParserError('pdf_too_many_pages');
    const blocks: DocumentBlock[] = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
      const result = await parser.getText({ partial: [pageNumber], pageJoiner: '' });
      for (const page of result.pages) {
        for (const text of splitParagraphs(page.text)) {
          extractedCharacters += text.length;
          if (extractedCharacters > MAX_EXTRACTED_CHARACTERS) {
            throw new DocumentParserError('text_too_large');
          }
          blocks.push({
            ...baseBlock(blocks.length, [], page.num),
            kind: 'paragraph',
            text,
          });
          if (blocks.length > 2_000) throw new DocumentParserError('too_many_units');
        }
      }
    }
    if (blocks.length === 0) {
      if (info.total > MAX_PDF_VISUAL_INSPECTION_PAGES) {
        throw new DocumentParserError('pdf_visual_inspection_limit');
      }
      const imageResult = await parser.getImage({
        imageBuffer: false,
        imageDataUrl: false,
        imageThreshold: 0,
      });
      const imageBlocks: DocumentBlock[] = [];
      for (const page of imageResult.pages) {
        for (const image of page.images) {
          if (imageBlocks.length >= 2_000) throw new DocumentParserError('too_many_units');
          imageBlocks.push({
            ...baseBlock(imageBlocks.length, [], page.pageNumber),
            kind: 'image_ref',
            relationshipId: image.name,
            contentType: null,
            altText: null,
            requiresVisualProcessing: true,
          });
        }
      }
      return finish(
        adapter,
        source,
        imageBlocks,
        imageBlocks.length > 0
          ? [{
            code: 'ocr_required',
            blockIds: imageBlocks.map((block) => block.id),
          }]
          : [],
      );
    }
    return finish(adapter, source, blocks);
  } catch (error) {
    if (error instanceof DocumentParserError) throw error;
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('password') || message.includes('encrypted')) {
      throw new DocumentParserError('pdf_encrypted');
    }
    throw new DocumentParserError('invalid_pdf');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseDocx(
  adapter: DocumentParserAdapter,
  buffer: Buffer,
  source: DocumentIRSource,
): Promise<StructuredDocument> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DocumentParserError('invalid_docx');
  }
  try {
    const archive = await validateDocxArchive(buffer);
    const documentEntry = archive.file('word/document.xml');
    if (!documentEntry) throw new DocumentParserError('invalid_docx');
    const xml = await documentEntry.async('string');
    if (xml.length > MAX_EXTRACTED_CHARACTERS * 20) {
      throw new DocumentParserError('docx_resource_limit');
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new DocumentParserError('invalid_docx');
    }
    const parserErrors: string[] = [];
    const document = new DOMParser({
      errorHandler: {
        warning: () => undefined,
        error: (message) => { parserErrors.push(message); },
        fatalError: (message) => { parserErrors.push(message); },
      },
    }).parseFromString(xml, 'application/xml');
    if (parserErrors.length > 0) throw new DocumentParserError('invalid_docx');
    const body = descendants(document, 'body')[0];
    if (!body) throw new DocumentParserError('invalid_docx');

    const blocks: DocumentBlock[] = [];
    const warnings: DocumentWarning[] = [];
    const headingPath: string[] = [];
    let pendingList: Array<{ text: string; ordered: boolean }> = [];
    const flushList = () => {
      if (pendingList.length === 0) return;
      blocks.push({
        ...baseBlock(blocks.length, headingPath),
        kind: 'list',
        ordered: pendingList.every((item) => item.ordered),
        items: pendingList.map((item, ordinal) => ({ ordinal, text: item.text })),
      });
      pendingList = [];
    };

    for (const child of elementChildren(body)) {
      if (localName(child) === 'p') {
        const text = extractWordText(child).trim();
        const headingLevel = wordHeadingLevel(child);
        const isList = descendants(child, 'numPr').length > 0;
        if (isList && text) {
          pendingList.push({ text, ordered: true });
        } else {
          flushList();
          if (headingLevel && text) {
            updateHeadingPath(headingPath, headingLevel, text);
            blocks.push({
              ...baseBlock(blocks.length, headingPath),
              kind: 'heading',
              level: headingLevel,
              text,
            });
          } else if (text) {
            blocks.push({
              ...baseBlock(blocks.length, headingPath),
              kind: 'paragraph',
              text,
            });
          }
        }
        const images = descendants(child, 'blip');
        for (const image of images) {
          flushList();
          const docProperties = descendants(child, 'docPr')[0];
          blocks.push({
            ...baseBlock(blocks.length, headingPath),
            kind: 'image_ref',
            relationshipId: attribute(image, 'embed'),
            contentType: null,
            altText: attribute(docProperties, 'descr') ?? attribute(docProperties, 'title'),
            requiresVisualProcessing: true,
          });
        }
      } else if (localName(child) === 'tbl') {
        flushList();
        const rows = directOrNestedRows(child);
        const cells: Array<{
          rowIndex: number;
          columnIndex: number;
          rowSpan: number;
          columnSpan: number;
          text: string;
          isHeader: boolean;
        }> = [];
        let columnCount = 0;
        rows.forEach((row, rowIndex) => {
          const rowIsHeader = descendants(row, 'tblHeader').length > 0;
          let columnIndex = 0;
          for (const cell of elementChildren(row).filter((item) => localName(item) === 'tc')) {
            const spanNode = descendants(cell, 'gridSpan')[0];
            const columnSpan = Number(attribute(spanNode, 'val') ?? '1') || 1;
            if (descendants(cell, 'vMerge').length > 0) {
              warnings.push({
                code: 'table_vertical_merge_limited',
                blockIds: [`block-${String(blocks.length + 1).padStart(6, '0')}`],
              });
            }
            cells.push({
              rowIndex,
              columnIndex,
              rowSpan: 1,
              columnSpan,
              text: extractWordText(cell).trim(),
              isHeader: rowIsHeader,
            });
            columnIndex += columnSpan;
          }
          columnCount = Math.max(columnCount, columnIndex);
        });
        blocks.push({
          ...baseBlock(blocks.length, headingPath),
          kind: 'table',
          rowCount: rows.length,
          columnCount,
          cells,
        });
      }
    }
    flushList();
    const characterCount = blocks.reduce(
      (total, block) => total + documentBlockText(block).length,
      0,
    );
    if (characterCount > MAX_EXTRACTED_CHARACTERS) {
      throw new DocumentParserError('text_too_large');
    }
    const imageBlockIds = blocks
      .filter((block) => block.kind === 'image_ref')
      .map((block) => block.id);
    if (characterCount === 0 && imageBlockIds.length > 0) {
      warnings.push({
        code: 'visual_processing_required',
        blockIds: imageBlockIds,
      });
    }
    return finish(adapter, source, blocks, warnings);
  } catch (error) {
    if (error instanceof DocumentParserError || error instanceof DocumentIRValidationError) throw error;
    throw new DocumentParserError('invalid_docx', error);
  }
}

async function validateDocxArchive(buffer: Buffer): Promise<JSZip> {
  const minimumEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new DocumentParserError('invalid_docx');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount > MAX_DOCX_ENTRIES) throw new DocumentParserError('docx_resource_limit');
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new DocumentParserError('invalid_docx');
  }

  let offset = centralDirectoryOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new DocumentParserError('invalid_docx');
    }
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    if (uncompressedSize === 0xffffffff) throw new DocumentParserError('docx_resource_limit');
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new DocumentParserError('docx_resource_limit');
    }
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw new DocumentParserError('invalid_docx');
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_DOCX_ENTRIES) throw new DocumentParserError('docx_resource_limit');
  let actualUncompressedBytes = 0;
  for (const entry of entries) {
    actualUncompressedBytes = await countExpandedBytes(entry, actualUncompressedBytes);
  }
  return archive;
}

function countExpandedBytes(entry: JSZipObject, initialBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = initialBytes;
    let settled = false;
    const stream = entry.nodeStream('nodebuffer');
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
      reject(error);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
        fail(new DocumentParserError('docx_resource_limit'));
      }
    });
    stream.on('error', () => fail(new DocumentParserError('docx_resource_limit')));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });
  });
}

function finish(
  adapter: DocumentParserAdapter,
  source: DocumentIRSource,
  blocks: DocumentBlock[],
  warnings: DocumentWarning[] = [],
): StructuredDocument {
  return createStructuredDocument({
    source,
    parser: { name: adapter.name, version: adapter.version },
    blocks,
    warnings,
  });
}

function baseBlock(
  order: number,
  headingPath: string[],
  pageNumber: number | null = null,
): Pick<
  DocumentBlock,
  'id' | 'order' | 'pageNumber' | 'headingPath' | 'confidence' | 'layout'
  | 'excluded' | 'exclusionReason'
> {
  return {
    id: `block-${String(order + 1).padStart(6, '0')}`,
    order,
    pageNumber,
    headingPath: [...headingPath],
    confidence: null,
    layout: null,
    excluded: false,
    exclusionReason: null,
  };
}

function updateHeadingPath(path: string[], level: number, value: string): void {
  path.splice(Math.min(level - 1, path.length));
  path.push(value);
}

function renderBlockText(block: DocumentBlock): string {
  switch (block.kind) {
    case 'list':
      return block.items.map((item) => (
        block.ordered ? `${item.ordinal + 1}. ${item.text}` : `- ${item.text}`
      )).join('\n');
    case 'table': {
      const rows = Array.from({ length: block.rowCount }, () => (
        Array.from({ length: block.columnCount }, () => '')
      ));
      for (const cell of block.cells) {
        if (rows[cell.rowIndex]) rows[cell.rowIndex][cell.columnIndex] = cell.text;
      }
      return rows.map((row) => row.join(' | ')).join('\n');
    }
    default:
      return documentBlockText(block);
  }
}

function structuralParts(block: DocumentBlock): {
  header: string | null;
  items: string[];
} | null {
  if (block.kind === 'list') {
    return {
      header: null,
      items: block.items.map((item) => (
        block.ordered ? `${item.ordinal + 1}. ${item.text}` : `- ${item.text}`
      )),
    };
  }
  if (block.kind === 'key_value') {
    return {
      header: null,
      items: block.pairs.map((pair) => `${pair.key}: ${pair.value}`),
    };
  }
  if (block.kind !== 'table') return null;
  const rows = Array.from({ length: block.rowCount }, () => (
    Array.from({ length: block.columnCount }, () => '')
  ));
  const headerRows = new Set<number>();
  for (const cell of block.cells) {
    if (rows[cell.rowIndex]) rows[cell.rowIndex][cell.columnIndex] = cell.text;
    if (cell.isHeader) headerRows.add(cell.rowIndex);
  }
  const rendered = rows.map((row) => row.join(' | '));
  return {
    header: [...headerRows].sort((a, b) => a - b).map((index) => rendered[index]).join('\n') || null,
    items: rendered.filter((_, index) => !headerRows.has(index)),
  };
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new DocumentParserError('invalid_utf8');
  }
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean);
}

function localName(node: Node | null | undefined): string {
  if (!node) return '';
  return (node as Element).localName ?? node.nodeName.replace(/^.*:/, '');
}

function elementChildren(node: Node): Element[] {
  const children: Element[] = [];
  const childNodes = node.childNodes;
  if (!childNodes) return children;
  for (let index = 0; index < childNodes.length; index += 1) {
    const child = childNodes.item(index);
    if (child?.nodeType === 1) children.push(child as Element);
  }
  return children;
}

function descendants(node: Node, name: string): Element[] {
  const results: Element[] = [];
  const visit = (current: Node) => {
    if (current.nodeType === 1 && localName(current) === name) {
      results.push(current as Element);
    }
    const childNodes = current.childNodes;
    if (!childNodes) return;
    for (let index = 0; index < childNodes.length; index += 1) {
      const child = childNodes.item(index);
      if (child) visit(child);
    }
  };
  visit(node);
  return results;
}

function attribute(node: Element | null | undefined, name: string): string | null {
  if (!node) return null;
  for (let index = 0; index < node.attributes.length; index += 1) {
    const item = node.attributes.item(index);
    if (item && (item.localName === name || item.name === name || item.name.endsWith(`:${name}`))) {
      return item.value;
    }
  }
  return null;
}

function extractWordText(node: Node): string {
  let output = '';
  const visit = (current: Node) => {
    const name = localName(current);
    if (name === 't') {
      output += current.textContent ?? '';
      return;
    }
    if (name === 'tab') {
      output += '\t';
      return;
    }
    if (name === 'br') {
      output += '\n';
      return;
    }
    const childNodes = current.childNodes;
    if (!childNodes) return;
    for (let index = 0; index < childNodes.length; index += 1) {
      const child = childNodes.item(index);
      if (child) visit(child);
    }
  };
  visit(node);
  return output;
}

function wordHeadingLevel(paragraph: Element): number | null {
  const style = descendants(paragraph, 'pStyle')[0];
  const value = attribute(style, 'val') ?? '';
  const match = value.match(/(?:heading|标题)\s*([1-6])/i);
  return match ? Number(match[1]) : null;
}

function directOrNestedRows(table: Element): Element[] {
  return elementChildren(table).filter((child) => localName(child) === 'tr');
}

export class DocumentParserError extends Error {
  constructor(public readonly failureCode: string, cause?: unknown) {
    super(failureCode, cause === undefined ? undefined : { cause });
  }
}
