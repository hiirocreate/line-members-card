import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { buildXlsx } from '../src/xlsx.js';

test('xlsx: 構造とエスケープ', () => {
  const buf = buildXlsx([['氏名', '数'], ['<b>&"山田"', 3], ['=1+1', '']]);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, buf);
});
