import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { bindDocxDocument, createNapiDocxEngineBinding, inspectDocxStyleSnapshot, type DocxEngineBinding } from '@opensuite/engine-client';
import type { StyleProfile, StyleProfileData } from '@opensuite/contracts';
import { buildStyleApplicationPlan, applyStylePlan, applyStyleProfileToDocument, styleApplicationSummary } from './application.js';
import { compareStyleFidelity } from './fidelity.js';
import { normalizeStyleSnapshot } from './normalize.js';
import { createPrimaryDocxTools } from '../agent/docx-tools.js';
import type { StyleProfileService } from './service.js';
import type { DocumentService } from '../documents/service.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function simpleProfile(): StyleProfileData {
  return { schemaVersion: 1, body: { text: { fontFamily: 'Arial', fontSizeHalfPoints: 22, color: '123456' }, paragraph: { spacingBeforeTwips: 160, spacingAfterTwips: 240 }, evidence: { paragraphCount: 2, runCount: 2, source: 'named_style' } }, headings: [], emphasis: [], palette: { text: [], headings: [], tableFills: [], borders: [] }, lists: [], headersFooters: { present: false, variants: [] }, diagnostics: [], unresolvedThemeReferences: [], evidence: { paragraphCount: 2, runCount: 2, tableCount: 0, truncated: false } };
}
const saved = (style: StyleProfileData): StyleProfile => ({ id: 'profile-1', name: 'Blue Harbor Operating Report Style', style, createdAt: '', updatedAt: '', source: { type: 'docx', documentId: 'source', versionId: 'source-v1', workspaceId: 'workspace', fileName: 'source.docx', extractedAt: '', snapshotSchemaVersion: 1, normalizerVersion: 1 } });

test('planning is deterministic, absent values stay absent, and unsupported values stay explicit', () => {
  const style = simpleProfile();
  style.body.text.color = 'theme:accent1';
  style.body.text.fontSizeHalfPoints = -1;
  style.body.paragraph.lineSpacing = { value: 276, rule: 'auto' };
  style.body.paragraph.alignment = 'justify';
  style.body.paragraph.keepWithNext = true;
  style.body.paragraph.leftIndentTwips = 720;
  style.page = { sampleCount: 1, orientationSource: 'unknown', marginsTwips: { left: 1440, right: -99 }, differentFirstPage: false, oddEvenHeaders: false };
  const plan = buildStyleApplicationPlan(style);
  assert.deepEqual(plan, buildStyleApplicationPlan(structuredClone(style)));
  assert.equal(plan.roles.body?.text.fontSizeHalfPoints, undefined);
  assert.equal(plan.roles.body?.text.color, undefined);
  assert.equal(plan.roles.body?.text.bold, undefined);
  assert.equal(plan.roles.body?.paragraph.leftIndentTwips, 720);
  assert.equal(plan.page.orientation, undefined);
  assert.equal(plan.page.paperSize, undefined);
  assert.equal(plan.page.rightMarginTwips, undefined);
  for (const field of ['body.text.color', 'body.text.fontSizeHalfPoints', 'body.paragraph.lineSpacing', 'body.paragraph.alignment', 'body.paragraph.keepWithNext', 'page.margins.right']) assert.ok(plan.unsupported.includes(field), field);
});

test('profile and target ownership and current version are checked before engine access', async () => {
  const binding = {} as DocxEngineBinding;
  let reads = 0;
  const documents = { getOwnedDocument: async () => { reads++; return { id: 'target', workspaceId: 'workspace', format: 'docx', latestVersion: { id: 'v1' } } as never; } };
  const input = { profileId: 'profile', documentId: 'target', versionId: 'v1', ownerUserId: 'alice', workspaceId: 'workspace', bytes: new Uint8Array(), binding, documents };
  await assert.rejects(() => applyStyleProfileToDocument({ ...input, profiles: { get: async () => { throw new Error('Style profile not found'); } } }), /not found/);
  assert.equal(reads, 0);
  const profiles = { get: async (owner: string) => { assert.equal(owner, 'alice'); return saved(simpleProfile()); } };
  await assert.rejects(() => applyStyleProfileToDocument({ ...input, profiles, documents: { getOwnedDocument: async () => { throw new Error('Document not found'); } } }), /not found/);
  await assert.rejects(() => applyStyleProfileToDocument({ ...input, profiles, workspaceId: 'other' }), /workspace/);
  await assert.rejects(() => applyStyleProfileToDocument({ ...input, profiles, versionId: 'old' }), /version changed/);
});

async function newsletterFixture(binding: DocxEngineBinding) {
  const host = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  async function edit(capability: string, operation: Record<string, unknown>) {
    const result = await host.mutate(capability, operation);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  await edit('insert_paragraphs', { texts: ['Cincinnati Sports Club — October Newsletter', 'Sample newsletter for members. All events below are test data.', 'Club News', 'The sample club has 120 members.', 'Upcoming Events', 'Practice is scheduled for October 12.', 'Volunteer information', 'Bring water to practice.', 'Bring water to practice.'], placement: { kind: 'end' } });
  for (const [text, style] of [['Cincinnati Sports Club — October Newsletter', 'Title'], ['Club News', 'Heading 1'], ['Upcoming Events', 'Heading 1'], ['Volunteer information', 'Heading 2']]) await edit('set_paragraph_style', { target: { text }, style });
  await edit('set_paragraphs_list', { targets: [{ text: 'Bring water to practice.', occurrence: 0 }, { text: 'Bring water to practice.', occurrence: 1 }], kind: 'bullet' });
  await edit('create_table', { placement: { kind: 'end' }, rows: [['Activity', 'Test date'], ['Practice', 'October 12'], ['Social', 'October 20']] });
  await edit('set_page_setup', { paperSize: 'a4', topMarginTwips: 720, rightMarginTwips: 720, bottomMarginTwips: 720, leftMarginTwips: 720 });
  return host.currentBytes();
}

const local = !!process.env.OPENSUITE_ENGINE_PATH;
test('Blue Harbor → newsletter: inspected fidelity, source safety, content preservation, lists, repeated text, and immutable save', { skip: !local }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const sourcePath = new URL('../../../../Blue Harbor Technologies — September 2026 Monthly Operating Report.docx', import.meta.url);
  const source = await readFile(sourcePath);
  const profile = saved(normalizeStyleSnapshot(await inspectDocxStyleSnapshot(source, binding)));
  const target = await newsletterFixture(binding);
  const before = await binding.inspectDocx(target, { focus: { kind: 'paragraphs', limit: 100 } });
  const listsBefore = (await inspectDocxStyleSnapshot(target, binding)).lists;
  let gets = 0;
  const profiles = { get: async (owner: string, id: string) => { assert.equal(owner, 'alice'); assert.equal(id, profile.id); gets++; return profile; } } as StyleProfileService;
  let appends = 0;
  let output = target;
  const documents = {
    getOwnedDocument: async () => ({ id: 'target', workspaceId: 'workspace', format: 'docx', latestVersion: { id: 'v1' } }),
    readExactVersionBytes: async () => Buffer.from(target),
    appendDocumentVersion: async (input: { bytes: Buffer; baseVersionId: string }) => { assert.equal(input.baseVersionId, 'v1'); appends++; output = input.bytes; return { version: { id: 'v2', versionNumber: 2 } }; },
  } as unknown as DocumentService;
  const session = await createPrimaryDocxTools({ binding, documents, ownerUserId: 'alice', workspaceId: 'workspace', documentId: 'target', versionId: 'v1' });
  assert.ok(session);
  const result = await session.applyStyleProfile(profile.id, profiles);
  assert.equal(gets, 1, 'Application resolves the saved profile, even if the model skipped get_profile');
  assert.equal(appends, 0, 'Application must not save early');
  const fidelity = session.getStyleFidelity();
  assert.ok(fidelity);
  assert.equal(fidelity.summary.counts.mismatched, 0, JSON.stringify(fidelity));
  for (const field of ['body.text.fontFamily', 'body.text.fontSizeHalfPoints', 'body.paragraph.spacingBeforeTwips', 'body.paragraph.spacingAfterTwips', 'Title.text.fontSizeHalfPoints', 'Title.text.bold', 'Heading1.text.fontSizeHalfPoints', 'Heading1.text.bold', 'page.margins.left', 'page.size', 'table.headerFill', 'table.headerBold', 'table.borders', 'table.padding.left', 'table.columnWidthTotal']) assert.equal(fidelity.fields.find(f => f.field === field)?.status, 'matched', field);
  assert.ok(fidelity.summary.unsupported.includes('body.paragraph.lineSpacing'));
  assert.ok(JSON.stringify(result).length < 1800, 'Model result stays compact');
  await session.flush();
  assert.equal(appends, 1);
  const after = await binding.inspectDocx(output, { focus: { kind: 'paragraphs', limit: 100 } });
  assert.deepEqual(after.paragraphs?.items.map(p => p.text), before.paragraphs?.items.map(p => p.text));
  assert.deepEqual((await inspectDocxStyleSnapshot(output, binding)).lists, listsBefore);
  assert.equal(hash(await readFile(sourcePath)), hash(source));
  const text = (after.paragraphs?.items.map(p => p.text) ?? []).join('\n');
  assert.doesNotMatch(text, /Blue Harbor|revenue|September 2026/i);
  const snapshot = await inspectDocxStyleSnapshot(output, binding);
  const mismatch = compareStyleFidelity(buildStyleApplicationPlan(profile.style), { ...snapshot, typography: { ...snapshot.typography, runPatterns: snapshot.typography.runPatterns.map(p => ({ ...p, effectiveFormatting: { ...p.effectiveFormatting, fontFamily: 'Wrong font' } })) } });
  assert.ok(mismatch.summary.mismatched.includes('body'));
  const absent = compareStyleFidelity(buildStyleApplicationPlan(profile.style), { ...snapshot, tables: [], tableCount: 0 });
  assert.equal(absent.fields.find(f => f.field === 'table.headerFill')?.status, 'not_applicable');
  // A small, shareable artifact from the real engine run; no model calls.
  await writeFile('/private/tmp/opensuite-phase3-newsletter.docx', output);
  await writeFile('/private/tmp/opensuite-phase3-fidelity.json', JSON.stringify(fidelity, null, 2));
  console.log('Phase 3 fidelity:', JSON.stringify(styleApplicationSummary({ profileId: profile.id, profileName: profile.name, documentId: 'target', fidelity })));
});

test('Title, Heading2, body colors and alignment, explicit landscape, and unsupported source facts', { skip: !local }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const style = simpleProfile();
  style.title = { ...structuredClone(style.body), text: { fontFamily: 'Arial', fontSizeHalfPoints: 40, bold: true, italic: true, color: 'ABCDEF' }, paragraph: { alignment: 'center', spacingAfterTwips: 280 } };
  style.headings = [{ ...structuredClone(style.body), level: 2, text: { fontFamily: 'Arial', fontSizeHalfPoints: 28, bold: true }, paragraph: { spacingBeforeTwips: 240, spacingAfterTwips: 120, alignment: 'right' } }];
  style.page = { sampleCount: 1, pageWidthTwips: 15840, pageHeightTwips: 12240, orientation: 'landscape', orientationSource: 'explicit', marginsTwips: { top: 1440, left: 1440 }, differentFirstPage: false, oddEvenHeaders: false };
  style.unresolvedThemeReferences = [{ property: 'font', value: 'majorHAnsi', count: 1 }];
  const result = await applyStylePlan(binding, await newsletterFixture(binding), buildStyleApplicationPlan(style));
  assert.equal(result.fidelity.summary.counts.mismatched, 0, JSON.stringify(result.fidelity));
  for (const field of ['Title.text.italic', 'Title.text.color', 'Title.paragraph.alignment', 'Heading2.text.fontSizeHalfPoints', 'Heading2.paragraph.alignment', 'body.text.color', 'page.orientation']) assert.equal(result.fidelity.fields.find(f => f.field === field)?.status, 'matched', field);
  assert.ok(result.fidelity.summary.unsupported.includes('unresolvedThemeReferences'));
});

test('engine ambiguity is still rejected; saved application resolves duplicate body text beside table text', { skip: !local }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const host = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  assert.equal((await host.mutate('insert_paragraphs', { texts: ['Same text', 'Same text'], placement: { kind: 'end' } })).ok, true);
  assert.equal((await host.mutate('create_table', { placement: { kind: 'end' }, rows: [['Same text', 'Other']] })).ok, true);
  assert.equal((await host.mutate('set_text_formatting', { target: { text: 'Same text' }, bold: true })).reasonCode, 'TARGET_AMBIGUOUS');
  const result = await applyStylePlan(binding, host.currentBytes(), buildStyleApplicationPlan(simpleProfile()));
  assert.equal(result.fidelity.summary.counts.mismatched, 0, JSON.stringify(result.fidelity));
  assert.equal(result.fidelity.summary.unsupported.includes('body.unsafeTextTarget'), false);
});

test('failed staged application leaves earlier working edits and versions intact', { skip: !local }, async () => {
  const real = await createNapiDocxEngineBinding();
  const original = await newsletterFixture(real);
  let paragraphCalls = 0;
  const binding: DocxEngineBinding = { ...real, executeDocxSetParagraphFormatting: async () => {
    paragraphCalls++;
    return { result: { ok: false, status: 'error', changes: [], diagnostics: [{ code: 'UNSUPPORTED_OPERATION', severity: 'error', message: 'Unsupported test paragraph' }] } };
  } };
  let appends = 0;
  const documents = {
    getOwnedDocument: async () => ({ id: 'target', workspaceId: 'workspace', format: 'docx', latestVersion: { id: 'v1' } }),
    readExactVersionBytes: async () => Buffer.from(original),
    appendDocumentVersion: async () => { appends++; return { version: { id: 'v2', versionNumber: 2 } }; },
  } as unknown as DocumentService;
  const profiles = { get: async () => saved(simpleProfile()) };
  const session = await createPrimaryDocxTools({ binding, documents, ownerUserId: 'alice', workspaceId: 'workspace', documentId: 'target', versionId: 'v1' });
  assert.ok(session);
  await assert.rejects(() => session.applyStyleProfile('profile-1', profiles), /UNSUPPORTED_OPERATION/);
  assert.equal(paragraphCalls, 1, 'Failure occurs after a successful staged typography edit');
  assert.equal(session.getWorkingDocument(), null);
  assert.equal(session.getWorkingRevision(), 0);
  assert.equal(session.getStyleFidelity(), null);
  await session.flush();
  assert.equal(appends, 0);
});

test('substring collisions stay unresolved instead of styling the wrong paragraph', { skip: !local }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const host = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  await host.mutate('insert_paragraphs', { texts: ['News', 'Club News'], placement: { kind: 'end' } });
  const result = await applyStylePlan(binding, host.currentBytes(), buildStyleApplicationPlan(simpleProfile()));
  assert.ok(result.fidelity.summary.unsupported.includes('body.unsafeTextTarget'));
  assert.ok(result.fidelity.summary.counts.mismatched, 'Unmet supported formatting is not silently reported as matched');
});

test('body indent conventions never overwrite existing list indentation', { skip: !local }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const host = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  await host.mutate('insert_paragraphs', { texts: ['Body paragraph', 'List item'], placement: { kind: 'end' } });
  await host.mutate('set_paragraphs_list', { targets: [{ text: 'List item' }], kind: 'bullet' });
  const before = await inspectDocxStyleSnapshot(host.currentBytes(), binding);
  const style = simpleProfile();
  style.body.paragraph.leftIndentTwips = 0;
  const result = await applyStylePlan(binding, host.currentBytes(), buildStyleApplicationPlan(style));
  const after = await inspectDocxStyleSnapshot(result.bytes, binding);
  assert.deepEqual(after.lists, before.lists);
  assert.ok(after.paragraphPatterns.some(p => p.directFormatting.leftIndentTwips === undefined));
  assert.ok(after.paragraphPatterns.some(p => p.directFormatting.leftIndentTwips === 0));
  assert.ok(result.fidelity.summary.unsupported.includes('body.paragraph.leftIndentTwips'));
  assert.equal(result.fidelity.summary.counts.mismatched, 0);
});
