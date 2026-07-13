import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { DocumentFormat } from '../types/domain';
import { SemanticUnit } from './document-chunker';

const MAX_EXTRACTED_CHARACTERS = 200_000;
const MAX_PDF_PAGES = 2_000;
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

export interface ParsedDocument {
  units: SemanticUnit[];
  characterCount: number;
}

export async function parseDocument(buffer: Buffer, format: DocumentFormat): Promise<ParsedDocument> {
  switch (format) {
    case 'txt':
      return fromPlainText(decodeUtf8(buffer));
    case 'md':
      return fromMarkdown(decodeUtf8(buffer));
    case 'pdf':
      return fromPdf(buffer);
    case 'docx':
      return fromDocx(buffer);
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new DocumentParserError('invalid_utf8');
  }
}

function fromPlainText(text: string): ParsedDocument {
  const units = splitParagraphs(text).map((content) => ({ content }));
  return finish(units);
}

function fromMarkdown(text: string): ParsedDocument {
  const units: SemanticUnit[] = [];
  let title: string | null = null;
  for (const block of splitParagraphs(text)) {
    const heading = block.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      title = heading[1].trim();
      units.push({ content: title, title });
    } else {
      units.push({ content: block, title });
    }
  }
  return finish(units);
}

async function fromPdf(buffer: Buffer): Promise<ParsedDocument> {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new DocumentParserError('invalid_pdf');
  }
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    stopAtErrors: true,
    isEvalSupported: false,
    maxImageSize: 1,
  });
  try {
    const info = await parser.getInfo();
    if (info.total > MAX_PDF_PAGES) throw new DocumentParserError('pdf_too_many_pages');
    const units: SemanticUnit[] = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
      const result = await parser.getText({ partial: [pageNumber] });
      for (const page of result.pages) {
        for (const content of splitParagraphs(page.text)) {
          extractedCharacters += content.length;
          if (extractedCharacters > MAX_EXTRACTED_CHARACTERS) {
            throw new DocumentParserError('text_too_large');
          }
          units.push({ content, pageStart: page.num, pageEnd: page.num });
          if (units.length > 2_000) throw new DocumentParserError('too_many_units');
        }
      }
    }
    if (units.length === 0) throw new DocumentParserError('pdf_no_text');
    return finish(units);
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

async function fromDocx(buffer: Buffer): Promise<ParsedDocument> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DocumentParserError('invalid_docx');
  }
  try {
    validateDocxArchive(buffer);
    const result = await mammoth.extractRawText({ buffer });
    if (result.value.length > MAX_EXTRACTED_CHARACTERS) {
      throw new DocumentParserError('text_too_large');
    }
    return finish(splitParagraphs(result.value).map((content) => ({ content })));
  } catch (error) {
    if (error instanceof DocumentParserError) throw error;
    throw new DocumentParserError('invalid_docx');
  }
}

function validateDocxArchive(buffer: Buffer): void {
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
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean);
}

function finish(units: SemanticUnit[]): ParsedDocument {
  if (units.length === 0) throw new DocumentParserError('empty_content');
  const characterCount = units.reduce((total, unit) => total + unit.content.length, 0);
  if (characterCount > MAX_EXTRACTED_CHARACTERS) {
    throw new DocumentParserError('text_too_large');
  }
  return {
    units,
    characterCount,
  };
}

export class DocumentParserError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}
