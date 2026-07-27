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

function createImagePdf(): Buffer {
  const imageStream = '\xff';
  const contentStream = 'q 100 0 0 100 72 620 cm /Im0 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray `
      + `/BitsPerComponent 8 /Length ${Buffer.byteLength(imageStream, 'latin1')} >>\n`
      + `stream\n${imageStream}\nendstream`,
    `<< /Length ${Buffer.byteLength(contentStream)} >>\nstream\n${contentStream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

async function createDocx(text: string, compression: 'STORE' | 'DEFLATE' = 'STORE'): Promise<Buffer> {
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
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

async function createStructuredDocx(): Promise<Buffer> {
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
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
      <w:body>
        <w:p>
          <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
          <w:r><w:t>Returns</w:t></w:r>
        </w:p>
        <w:p><w:r><w:t>Apply within seven days.</w:t></w:r></w:p>
        <w:p>
          <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
          <w:r><w:t>Provide an order number</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
          <w:r><w:t>Keep the receipt</w:t></w:r>
        </w:p>
        <w:tbl>
          <w:tr>
            <w:trPr><w:tblHeader/></w:trPr>
            <w:tc><w:p><w:r><w:t>Method</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Days</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Card</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>7</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
        <w:p>
          <w:r>
            <w:drawing>
              <wp:inline>
                <wp:docPr id="1" name="Policy image" descr="Return label"/>
                <a:graphic><a:graphicData><a:blip r:embed="rId8"/></a:graphicData></a:graphic>
              </wp:inline>
            </w:drawing>
          </w:r>
        </w:p>
      </w:body>
    </w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function testFourFormatsAndStructure(): Promise<void> {
  const txt = await parseDocument(Buffer.from('第一段\n\n第二段'), 'txt');
  assert.deepEqual(txt.units.map((unit) => unit.content), ['第一段', '第二段']);
  assert.deepEqual(txt.representation.blocks.map((block) => block.kind), ['paragraph', 'paragraph']);
  assert.equal(txt.representation.parser.version, 'plain-text-v2');

  const markdown = await parseDocument(Buffer.from(
    '# Refunds\n\nApply within seven days.\n\n- Order number\n- Receipt\n\n```txt\npolicy code\n```\n\n## Shipping\n\nShips tomorrow.',
  ), 'md');
  assert.deepEqual(markdown.units.map((unit) => unit.title), [
    'Refunds',
    'Refunds',
    'Refunds',
    'Refunds',
    'Shipping',
    'Shipping',
  ]);
  assert.deepEqual(markdown.representation.blocks.map((block) => block.kind), [
    'heading',
    'paragraph',
    'list',
    'text',
    'heading',
    'paragraph',
  ]);
  assert.deepEqual(markdown.representation.blocks[2].headingPath, ['Refunds']);
  const skippedLevel = await parseDocument(Buffer.from('### Details\n\nNested without parents.'), 'md');
  assert.deepEqual(skippedLevel.representation.blocks[0].headingPath, ['Details']);
  assert.deepEqual(skippedLevel.representation.blocks[1].headingPath, ['Details']);

  const pdf = await parseDocument(createSimplePdf('Refunds are accepted within seven days.'), 'pdf');
  assert.equal(pdf.units[0].pageStart, 1);
  assert.match(pdf.units[0].content, /seven days/);
  assert.equal(pdf.representation.blocks[0].pageNumber, 1);

  const docx = await parseDocument(await createStructuredDocx(), 'docx');
  assert.deepEqual(docx.representation.blocks.map((block) => block.kind), [
    'heading',
    'paragraph',
    'list',
    'table',
    'image_ref',
  ]);
  assert.deepEqual(docx.representation.blocks[1].headingPath, ['Returns']);
  const table = docx.representation.blocks[3];
  assert.equal(table.kind, 'table');
  if (table.kind === 'table') {
    assert.equal(table.cells.find((cell) => cell.text === 'Method')?.isHeader, true);
    assert.equal(table.cells.find((cell) => cell.text === 'Card')?.rowIndex, 1);
  }
}

async function testInvalidAndScannedDocumentsFailSafely(): Promise<void> {
  await assert.rejects(
    parseDocument(Buffer.from([0xff, 0xfe, 0xfd]), 'txt'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'invalid_utf8',
  );
  const blank = await parseDocument(createSimplePdf(''), 'pdf');
  assert.equal(blank.units.length, 0);
  assert.equal(blank.representation.blocks.length, 0);
  assert.equal(blank.representation.warnings.some((warning) => warning.code === 'ocr_required'), false);

  const scanOnly = await parseDocument(createImagePdf(), 'pdf');
  assert.equal(scanOnly.units.length, 0);
  assert.equal(scanOnly.representation.blocks[0].kind, 'image_ref');
  assert.equal(scanOnly.representation.blocks[0].pageNumber, 1);
  assert.ok(scanOnly.representation.warnings.some((warning) => warning.code === 'ocr_required'));

  const emptyDocx = await parseDocument(await createDocx(''), 'docx');
  assert.equal(emptyDocx.units.length, 0);
  assert.equal(emptyDocx.representation.blocks.length, 0);

  const expandedDocx = await createDocx('small document');
  const centralDirectoryOffset = expandedDocx.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralDirectoryOffset >= 0);
  expandedDocx.writeUInt32LE(21 * 1024 * 1024, centralDirectoryOffset + 24);
  await assert.rejects(
    parseDocument(expandedDocx, 'docx'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'docx_resource_limit',
  );

  const compressedBomb = await createDocx('A'.repeat(21 * 1024 * 1024), 'DEFLATE');
  for (let offset = compressedBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); offset >= 0;) {
    compressedBomb.writeUInt32LE(100, offset + 24);
    offset = compressedBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4);
  }
  await assert.rejects(
    parseDocument(compressedBomb, 'docx'),
    (error) => error instanceof DocumentParserError && error.failureCode === 'docx_resource_limit',
    'actual expanded output must be capped even when ZIP metadata understates its size',
  );
}

Promise.all([testFourFormatsAndStructure(), testInvalidAndScannedDocumentsFailSafely()])
  .then(() => console.log('document parser tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
