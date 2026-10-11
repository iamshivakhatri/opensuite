// Run inside the finished API image; no server, database, or model is needed.
import './native-acceptance.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { bindDocxDocument, createNapiDocxEngineBinding, refreshDocxFields } from '../dist/index.js';

assert.ok(existsSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), 'DejaVu fonts must be installed');
const binding = await createNapiDocxEngineBinding();
const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
for (const [capability, operation] of [
  ['insert_paragraphs', { texts: ['Introduction', 'Report body'], placement: { kind: 'end' } }],
  ['set_paragraph_style', { target: { text: 'Introduction' }, style: 'Heading 1' }],
  ['insert_toc', { placement: { kind: 'start' }, title: 'Contents', maxHeadingLevel: 3 }],
  ['insert_fields', { location: 'footer', content: [{ kind: 'text', text: 'Page ' }, { kind: 'page' }] }],
]) {
  const result = await doc.mutate(capability, operation);
  assert.equal(result.ok, true, `${capability}: ${JSON.stringify(result)}`);
}
const refreshed = await refreshDocxFields(doc.currentBytes());
assert.equal(refreshed.status, 'refreshed', JSON.stringify({ ...refreshed, bytes: undefined }));
assert.ok(refreshed.bytes);
const fields = await binding.inspectDocxFields(refreshed.bytes);
const toc = fields.fields.find(field => field.kind === 'toc');
const page = fields.fields.find(field => field.kind === 'page');
assert.ok(toc && toc.dirty !== true && /Introduction/.test(toc.cachedResult ?? ''), 'TOC must contain its real heading');
assert.match(page?.cachedResult ?? '', /^\d+$/, 'PAGE must contain a refreshed number');
console.log('[image-acceptance] PASS: native edits, fonts, TOC and PAGE refresh');
