import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { DocumentFormat } from '../types/domain';
import { SemanticUnit } from './document-chunker';

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
    const result = await parser.getText();
    const units = result.pages.flatMap((page) => (
      splitParagraphs(page.text).map((content) => ({
        content,
        pageStart: page.num,
        pageEnd: page.num,
      }))
    ));
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
    const result = await mammoth.extractRawText({ buffer });
    return finish(splitParagraphs(result.value).map((content) => ({ content })));
  } catch {
    throw new DocumentParserError('invalid_docx');
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
  return {
    units,
    characterCount: units.reduce((total, unit) => total + unit.content.length, 0),
  };
}

export class DocumentParserError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}
