import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceBrandProfile } from '@opensuite/contracts';
import { createWorkspaceBrandTools } from './workspace-brand.js';
import { createToolSurface } from '../runtime/tool-surface.js';
import { buildMinimalDocx, createNapiDocxEngineBinding, inspectDocxStyleSnapshot } from '@opensuite/engine-client';
import { createPrimaryDocxTools } from '../../docx-tools.js';
import { resolveDocumentAppearance } from '../../../document-appearance/resolve.js';
import type { DocumentService } from '../../../documents/service.js';

const brand: WorkspaceBrandProfile = {
  schemaVersion: 1, workspaceId: 'workspace', createdAt: '', updatedAt: '', logoAssetId: 'logo',
  organization: { name: 'Sports Club', website: '', email: '', phone: '', address: '' },
  colors: { primary: '#123456', secondary: null, accent: null },
  typography: { headingFont: 'Arial', bodyFont: 'Arial' },
};

test('saved workspace brand is discoverable independently of personal style profiles', async () => {
  let applied = 0;
  const tools = createWorkspaceBrandTools({ getBrand: async () => brand, applyBrand: async value => {
    assert.equal(value, brand);
    applied++;
    return { matched: 3 };
  } });
  const surface = createToolSurface(tools);
  assert.equal(surface.initialTools['workspace.get_brand'], undefined);
  assert.match(JSON.stringify(surface.session.search('saved brand')), /workspace.get_brand/);
  assert.equal(surface.session.load(['workspace.get_brand', 'document.apply_workspace_brand']).ok, true);
  const projected = surface.projectTools();
  assert.deepEqual(await projected['workspace.get_brand']!.execute!({}, {} as never), { brand });
  assert.deepEqual(await projected['document.apply_workspace_brand']!.execute!({}, {} as never), { matched: 3 });
  assert.equal(applied, 1);
});

test('missing or inaccessible brands cannot be applied', async () => {
  let applied = false;
  const tools = createWorkspaceBrandTools({ getBrand: async () => null, applyBrand: async () => { applied = true; } });
  assert.deepEqual(await tools['workspace.get_brand']!.execute!({}, {} as never), { brand: null });
  await assert.rejects(async () => tools['document.apply_workspace_brand']!.execute!({}, {} as never), /No workspace brand/);
  assert.equal(applied, false);
  const denied = createWorkspaceBrandTools({ getBrand: async () => { throw new Error('Workspace not found'); } });
  await assert.rejects(async () => denied['workspace.get_brand']!.execute!({}, {} as never), /Workspace not found/);
  assert.equal(denied['document.apply_workspace_brand'], undefined);
});

test('branding an existing DOCX preserves its text and saves one verified version', async () => {
  const binding = await createNapiDocxEngineBinding();
  const original = buildMinimalDocx(['Dear Member,', 'The club meeting is on Tuesday.']);
  let saved: Buffer | undefined;
  let saves = 0;
  const documents = {
    getOwnedDocument: async () => ({ id: 'doc', workspaceId: 'workspace', format: 'docx', latestVersion: { id: 'v1' } }),
    readExactVersionBytes: async () => original,
    appendDocumentVersion: async (input: { bytes: Buffer }) => {
      saves++;
      saved = input.bytes;
      return { version: { id: 'v2', versionNumber: 2 } };
    },
  } as unknown as DocumentService;
  const session = (await createPrimaryDocxTools({ binding, documents, ownerUserId: 'user', workspaceId: 'workspace', documentId: 'doc', versionId: 'v1' }))!;
  const tools = createWorkspaceBrandTools({ getBrand: async () => brand, applyBrand: value => session.applyResolvedAppearance(resolveDocumentAppearance({
    workspaceBrand: { ...value, typography: { headingFont: 'Georgia', bodyFont: 'Georgia' } },
    policy: { channels: ['typography', 'colors', 'tableAccent'] },
  })) });
  await tools['document.apply_workspace_brand']!.execute!({}, {} as never);
  assert.equal(session.getStyleFidelity()?.summary.counts.mismatched, 0);
  assert.equal(saves, 0);
  await session.flush();
  await session.flush();
  assert.equal(saves, 1);
  assert.ok(saved);
  const found = await binding.findDocxText(saved, { text: 'The club meeting is on Tuesday.' });
  assert.equal(found.ok, true);
  assert.equal(found.matches.length, 1);
  const snapshot = await inspectDocxStyleSnapshot(saved, binding);
  assert.ok(snapshot.typography.runPatterns.some(pattern => (pattern.effectiveFormatting ?? pattern.directFormatting).fontFamily === 'Georgia'));
});
