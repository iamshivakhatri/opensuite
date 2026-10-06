import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestsSavedStyle, createStyleProfileTools } from './style-profiles.js';
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


test('named saved-style prompts recommend exact loadable tools and prevent generic substitution', () => {
  const profiles = {} as StyleProfileService;
  const tools = createStyleProfileTools({ profiles, ownerUserId: 'alice', workspaceId: 'workspace', currentDocument: () => ({ documentId, versionId, dirty: false }), applyProfile: async () => ({ matched: ['body'] }) });
  for (const prompt of ['Use my Resume Style and build me a resume.', 'Using the Blue Harbor Operating Report Style, create a newsletter.', 'Use this Resume Style to create a resume.', 'Apply the saved Blue Harbor style to this document.']) {
    const surface = createToolSurface(tools);
    assert.equal(requestsSavedStyle(prompt), true, prompt);
    const ids = surface.session.recommend(prompt).map(item => item.id);
    assert.deepEqual(ids, ['style.list_profiles', 'style.get_profile', 'style.apply_profile']);
    assert.equal(surface.session.load(ids).ok, true, 'No CAPABILITY_NOT_LOADABLE on the normal path');
    assert.equal(surface.session.load(['styles.career.clean-resume']).reasonCode, 'SAVED_STYLE_REQUIRED');
    assert.equal(surface.session.load(['skills.career.resume']).ok, true);
    assert.ok(surface.projectTools()['style.apply_profile']);
  }
  for (const prompt of ['Use an appropriate visual style.', 'Create a clean professional resume.', 'Learn the document style and save it.']) assert.equal(requestsSavedStyle(prompt), false, prompt);
});

test('apply capability validates ID and delegates to the working document service', async () => {
  let applied = 0;
  const tools = createStyleProfileTools({ profiles: {} as StyleProfileService, ownerUserId: 'alice', workspaceId: 'workspace', currentDocument: () => ({ documentId, versionId, dirty: true }), applyProfile: async id => { assert.equal(id, documentId); applied++; return { profileName: 'Report Style', matched: ['body'], mismatched: [] }; } });
  const result = await tools['style.apply_profile']!.execute!({ id: documentId }, {} as never);
  assert.equal(applied, 1);
  assert.ok(JSON.stringify(result).length < 200);
  await assert.rejects(async () => tools['style.apply_profile']!.execute!({ id: 'bad' }, {} as never));
  assert.equal(applied, 1);
});

test('applying a saved style to this document binds the open target', async () => {
  const { refersToOpenDocument } = await import('../../document-target.js');
  assert.equal(refersToOpenDocument('Apply my Resume Style to this document.'), true);
  assert.equal(refersToOpenDocument('Use my saved Blue Harbor Style on the current document.'), true);
  assert.equal(refersToOpenDocument('Use my Resume Style and create a new resume.'), false);
});
