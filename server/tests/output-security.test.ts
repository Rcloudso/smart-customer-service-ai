import assert from 'node:assert/strict';
import { escapeCsvCell } from '../utils/csv';

function main(): void {
  assert.equal(
    escapeCsvCell('=HYPERLINK("https://attacker.example")'),
    '"\'=HYPERLINK(""https://attacker.example"")"',
  );
  assert.equal(escapeCsvCell('  +SUM(1,2)'), "\"'  +SUM(1,2)\"");
  assert.equal(escapeCsvCell('-10'), "'-10");
  assert.equal(escapeCsvCell('@IMPORTDATA(A1)'), "'@IMPORTDATA(A1)");
  assert.equal(escapeCsvCell('normal, value'), '"normal, value"');
  assert.equal(escapeCsvCell('normal'), 'normal');
  console.log('Output security checks passed');
}

main();
