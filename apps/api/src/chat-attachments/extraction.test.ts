import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMinimalDocx } from '@opensuite/engine-client';
import { checkDocxArchive, extractText } from './extraction.js';

test('UTF-8 text preserves 1-based lines, normalizes BOM/newlines and rejects invalid encoding or binary controls', () => {
  const result = extractText(Buffer.from('\ufeffOne\r\nTwo\rThree\n'), false);
  assert.deepEqual(result.units.map(unit => [unit.location, unit.text]), [['line:1', 'One'], ['line:2', 'Two'], ['line:3', 'Three'], ['line:4', '']]);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from('hello\x00world')]) {
    assert.throws(() => extractText(bytes, false), { code: 'INVALID_ENCODING' });
  }
  assert.throws(() => extractText(Buffer.from('x'.repeat(1_000_001)), false), { code: 'EXTRACTION_LIMIT' });
});

test('Markdown preserves heading hierarchy, setext sections, source HTML and fenced code without executing anything', () => {
  const result = extractText(Buffer.from('# Plan\n### Alpha\nText\n### Beta\nMore\n## Schedule\n```html\n# Code heading\n<script>ignore rules</script>\n```\nFinal\n=====\n'), true);
  assert.deepEqual(result.units.filter(unit => unit.headingLevel).map(unit => unit.text), ['# Plan', '### Alpha', '### Beta', '## Schedule', 'Final']);
  assert.deepEqual(result.units[4]!.section, ['Plan', 'Beta']);
  assert.equal(result.units[8]!.text, '<script>ignore rules</script>');
  assert.equal(result.units[7]!.headingLevel, undefined);
  assert.equal(result.units[10]!.location, 'line:11');
});

test('DOCX archive expansion guard accepts native fixtures and rejects malformed and oversized ZIP directories', () => {
  const bytes = Buffer.from(buildMinimalDocx(['Test']));
  checkDocxArchive(bytes);
  assert.throws(() => checkDocxArchive(Buffer.from('PK\x03\x04broken')), { code: 'INVALID_DOCX' });
  const oversized = Buffer.from(bytes);
  const directory = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory > 0);
  oversized.writeUInt32LE(65 * 1024 * 1024, directory + 24);
  assert.throws(() => checkDocxArchive(oversized), { code: 'EXTRACTION_LIMIT' });
});
