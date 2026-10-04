import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StyleProfileData, WorkspaceBrandProfile } from '@opensuite/contracts';
import { bindDocxDocument, createNapiDocxEngineBinding } from '@opensuite/engine-client';
import { documentSkillPolicy } from '../agent/capabilities/definitions/skills/index.js';
import { applyStylePlan } from '../style-profiles/application.js';
import { compareStyleFidelity } from '../style-profiles/fidelity.js';
import {
  requestsNoWorkspaceBrand,
  resolveDocumentAppearance,
  shouldApplyAutomaticBrand,
} from './resolve.js';
import { readableTextColor } from './contrast.js';

const logoPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlQL0YAAAAASUVORK5CYII=', 'base64'));

const brand: WorkspaceBrandProfile = {
  schemaVersion: 1, workspaceId: 'workspace', createdAt: '', updatedAt: '', logoAssetId: 'logo',
  organization: { name: 'Cincinnati Sports Club', website: '', email: '', phone: '', address: '' },
  colors: { primary: '#123456', secondary: '#345678', accent: '#56789A' },
  typography: { headingFont: 'Aptos Display', bodyFont: 'Aptos' },
};
const savedStyle = (): StyleProfileData => ({
  schemaVersion: 1,
  body: { text: { fontFamily: 'Arial' }, paragraph: {}, evidence: { paragraphCount: 1, runCount: 1, source: 'named_style' } },
  headings: [{ level: 1, text: { fontFamily: 'Arial', color: 'ABCDEF' }, paragraph: {}, evidence: { paragraphCount: 1, runCount: 1, source: 'named_style' } }],
  emphasis: [], palette: { text: [], headings: [], tableFills: [], borders: [] }, lists: [],
  headersFooters: { present: false, variants: [] }, diagnostics: [], unresolvedThemeReferences: [],
  evidence: { paragraphCount: 1, runCount: 1, tableCount: 0, truncated: false },
});
const reportPolicy = documentSkillPolicy('skills.reporting.analytical-report')!;

test('saved style wins while workspace brand fills missing permitted appearance', () => {
  const style = savedStyle();
  style.body.text.color = 'ABCDEF';
  const appearance = resolveDocumentAppearance({ savedStyle: style, workspaceBrand: brand, policy: reportPolicy });
  assert.equal(appearance.plan.roles.body?.text.fontFamily, 'Arial');
  assert.equal(appearance.plan.roles.Heading1?.text.fontFamily, 'Arial');
  assert.equal(appearance.plan.roles.Heading1?.text.color, 'ABCDEF');
  assert.equal(appearance.plan.roles.Heading2?.text.fontFamily, 'Aptos Display');
  assert.equal(appearance.plan.roles.Heading2?.text.color, '345678');
  assert.equal(appearance.plan.table?.headerFill, '56789A');
  assert.equal(appearance.plan.table?.headerTextColor, 'ABCDEF');
  assert.equal(appearance.provenance['Heading1.text.color'], 'saved_style');
  assert.equal(appearance.provenance['table.headerTextColor'], 'saved_style');
  assert.equal(appearance.provenance['Heading2.text.color'], 'workspace_brand');
});

test('brand primary styles Title and Heading 1, and dark table fills use a readable foreground', () => {
  const appearance = resolveDocumentAppearance({
    workspaceBrand: { ...brand, colors: { primary: '#124733', secondary: null, accent: null } },
    policy: reportPolicy,
  });
  assert.equal(appearance.plan.roles.Title?.text.color, '124733');
  assert.equal(appearance.plan.roles.Heading1?.text.color, '124733');
  assert.equal(appearance.plan.table?.headerFill, '124733');
  assert.equal(appearance.plan.table?.headerTextColor, 'FFFFFF');
});

test('contrast color is deterministic and leaves invalid backgrounds alone', () => {
  assert.equal(readableTextColor('#124733'), 'FFFFFF');
  assert.equal(readableTextColor('#F3F4F6'), '000000');
  assert.equal(readableTextColor('not-a-color'), undefined);
});

test('document skill policies keep branding conservative', () => {
  assert.deepEqual(documentSkillPolicy('skills.reporting.analytical-report')?.channels, ['typography', 'colors', 'tableAccent', 'logo']);
  assert.deepEqual(documentSkillPolicy('skills.proposals.basic-proposal')?.channels, ['typography', 'colors', 'tableAccent', 'logo']);
  assert.deepEqual(documentSkillPolicy('skills.coordination.meeting-minutes')?.channels, ['typography']);
  for (const id of ['skills.reporting.recurring-update', 'skills.career.resume', 'skills.scientific-writing.scientific-paper']) {
    assert.deepEqual(documentSkillPolicy(id)?.channels, [], id);
  }
});

test('logo plans require a new permitted document', () => {
  const input = { workspaceBrand: brand, workspaceLogo: { bytes: logoPng, contentType: 'image/png' as const } };
  const newReport = resolveDocumentAppearance({ ...input, policy: reportPolicy, isNewDocument: true });
  assert.deepEqual(newReport.plan.logo?.imageBytes, logoPng);
  assert.equal(newReport.provenance.logo, 'workspace_brand');
  assert.equal(resolveDocumentAppearance({ ...input, policy: reportPolicy, isNewDocument: false }).plan.logo, undefined);
  assert.equal(resolveDocumentAppearance({ ...input, policy: documentSkillPolicy('skills.career.resume')!, isNewDocument: true }).plan.logo, undefined);
  assert.equal(resolveDocumentAppearance({ ...input, policy: documentSkillPolicy('skills.scientific-writing.scientific-paper')!, isNewDocument: true }).plan.logo, undefined);
});

test('automatic brand application is new-document only and respects a clear opt-out', () => {
  assert.equal(shouldApplyAutomaticBrand({ isNewDocument: false, policy: reportPolicy, instruction: 'Update this report' }), false);
  assert.equal(shouldApplyAutomaticBrand({ isNewDocument: true, policy: reportPolicy, instruction: 'Create a report, but do not use our company branding.' }), false);
  assert.equal(shouldApplyAutomaticBrand({ isNewDocument: true, policy: reportPolicy, instruction: 'Create a report' }), true);
  assert.equal(requestsNoWorkspaceBrand('Create a report without workspace branding.'), true);
});

test('workspace-brand fidelity identifies the source of matched fields', () => {
  const appearance = resolveDocumentAppearance({ workspaceBrand: brand, policy: { channels: ['typography'] } });
  const fidelity = compareStyleFidelity(appearance.plan, {
    ok: true, truncated: false, tableCount: 0, lists: [], headersFooters: [], sections: [], tables: [],
    styles: [{ styleId: 'Normal', name: 'Normal' }], defaults: { defaultParagraphStyleId: 'Normal' },
    paragraphPatterns: [{ styleId: 'Normal', locations: ['body'], effectiveFormatting: {} }],
    typography: { runPatterns: [{ paragraphStyleId: 'Normal', effectiveFormatting: { fontFamily: 'Aptos' } }] },
  } as never, [], appearance.provenance);
  assert.deepEqual(fidelity.fields.find((field) => field.field === 'body.text.fontFamily'), {
    field: 'body.text.fontFamily', status: 'matched', source: 'workspace_brand',
  });
});

test('report brand resolution uses the existing engine application plan', { skip: !process.env.OPENSUITE_ENGINE_PATH }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const host = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  assert.equal((await host.mutate('insert_paragraphs', { texts: ['September report', 'Operations', 'Revenue increased.'], placement: { kind: 'end' } })).ok, true);
  assert.equal((await host.mutate('set_paragraph_style', { target: { text: 'September report' }, style: 'Title' })).ok, true);
  assert.equal((await host.mutate('set_paragraph_style', { target: { text: 'Operations' }, style: 'Heading 1' })).ok, true);
  assert.equal((await host.mutate('create_table', { placement: { kind: 'end' }, rows: [['Metric', 'Value'], ['Revenue', '120']] })).ok, true);
  const appearance = resolveDocumentAppearance({ workspaceBrand: brand, policy: reportPolicy });
  const result = await applyStylePlan(binding, host.currentBytes(), appearance.plan, appearance.provenance);
  for (const field of ['body.text.fontFamily', 'Title.text.color', 'Heading1.text.color', 'table.headerFill']) {
    const item = result.fidelity.fields.find((entry) => entry.field === field);
    assert.equal(item?.status, 'matched', field);
    assert.equal(item?.source, 'workspace_brand', field);
  }
});
