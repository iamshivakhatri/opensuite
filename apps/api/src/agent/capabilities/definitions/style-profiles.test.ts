import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStyleProfileTools } from './style-profiles.js';
import { createToolSurface } from '../runtime/tool-surface.js';
import type { StyleProfileData } from '@opensuite/contracts';

import type { StyleProfileService } from '../../../style-profiles/service.js';

const documentId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
test('style capability is discovered, explicitly loaded, compact, and bound to exact saved version', async () => {
  const style: StyleProfileData = { schemaVersion: 1, body: { text: { fontFamily: 'Arial' }, paragraph: {}, evidence: { paragraphCount: 1, runCount: 1, source: 'defaults' } }, headings: [], emphasis: [], palette: { text: [], headings: [], tableFills: [], borders: [] }, lists: [], headersFooters: { present: false, variants: [] }, diagnostics: [], unresolvedThemeReferences: [], evidence: { paragraphCount: 1, runCount: 1, tableCount: 0, truncated: false } };
  let calls = 0;
  const profiles = {
    learnFromDocument: async input => {
      calls++;
      assert.equal(input.ownerUserId, 'alice');
      assert.equal(input.workspaceId, 'workspace');
      assert.equal(input.documentId, documentId);
      assert.equal(input.versionId, versionId);
      return { id: documentId, name: 'Report Style', createdAt: '', updatedAt: '', source: { type: 'docx', documentId, versionId, workspaceId: 'workspace', fileName: 'report.docx', extractedAt: '', snapshotSchemaVersion: 1, normalizerVersion: 1 }, style: style };
    },
  } as StyleProfileService;
  let dirty = false;
  const tools = createStyleProfileTools({ profiles, ownerUserId: 'alice', workspaceId: 'workspace', currentDocument: () => ({ documentId, versionId, dirty }) });
  const surface = createToolSurface(tools);
  assert.equal(surface.initialTools['style.learn_from_document'], undefined);
  assert.ok(JSON.stringify(surface.session.search('learn style', 1)).includes('style.learn_from_document'));
  surface.session.load(['style.learn_from_document'], 1);
  const selected = surface.projectTools({ turn: 2 });
  assert.ok(selected['style.learn_from_document']);
  assert.equal(calls, 0);
  const result = await selected['style.learn_from_document']!.execute!({}, {} as never);
  const json = JSON.stringify(result);
  assert.ok(json.length < 6000);
  assert.equal(json.includes('runPatterns'), false);
  assert.equal(json.includes('paragraphPatterns'), false);
  assert.equal(json.includes('directFormatting'), false);
  assert.equal(calls, 1);
  dirty = true;
  await assert.rejects(() => Promise.resolve(tools['style.learn_from_document']!.execute!({}, {} as never)), /unsaved edits/);
  assert.equal(calls, 1);
});
