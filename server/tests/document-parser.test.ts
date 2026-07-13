import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseDocument, DocumentParserError } from '../ai/document-parser';

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

async function createDocx(text: string): Promise<Buffer> {
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
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function testFourFormatsAndStructure(): Promise<void> {
  const txt = await parseDocument(Buffer.from('第一段\n\n第二段'), 'txt');
  assert.deepEqual(txt.units.map((unit) => unit.content), ['第一段', '第二段']);

  const markdown = await parseDocument(Buffer.from('# Refunds\n\nApply within seven days.\n\n## Shipping\n\nShips tomorrow.'), 'md');
  assert.deepEqual(markdown.units.map((unit) => unit.title), ['Refunds', 'Refunds', 'Shipping', 'Shipping']);

  const pdf = await parseDocument(createSimplePdf('Refunds are accepted within seven days.'), 'pdf');
  assert.equal(pdf.units[0].pageStart, 1);
  assert.match(pdf.units[0].content, /seven days/);

  const docx = await parseDocument(await createDocx('DOCX refund policy'), 'docx');
  assert.equal(docx.units[0].content, 'DOCX refund policy');
}

async function testInvalidAndScannedDocumentsFailSafely(): Promise<void> {
  await assert.rejects(
    parseDocument(Buffer.from([0xff, 0xfe, 0xfd]), 'txt'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'invalid_utf8',
  );
  await assert.rejects(
    parseDocument(createSimplePdf(''), 'pdf'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'pdf_no_text',
  );

  const expandedDocx = await createDocx('small document');
  const centralDirectoryOffset = expandedDocx.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralDirectoryOffset >= 0);
  expandedDocx.writeUInt32LE(21 * 1024 * 1024, centralDirectoryOffset + 24);
  await assert.rejects(
    parseDocument(expandedDocx, 'docx'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'docx_resource_limit',
  );
}

Promise.all([testFourFormatsAndStructure(), testInvalidAndScannedDocumentsFailSafely()])
  .then(() => console.log('document parser tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
