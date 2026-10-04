import type { StyleProfileData, StyleRole } from '@opensuite/contracts';
import {
  bindDocxDocument, inspectDocxStyleSnapshot,
  type DocxEngineBinding, type DocxInspectParagraphItem, type DocxInspectTableItem,
  type DocxSetTextFormattingOperation, type DocxSetParagraphFormattingOperation,
  type DocxSetTableFormattingOperation,
} from '@opensuite/engine-client';
import type { DocumentService } from '../documents/service.js';
import { StyleProfileError, type StyleProfileService } from './service.js';
import { paragraphRole } from './normalize.js';
import { appendStyleFidelityField, compareStyleFidelity, type StyleFidelityReport } from './fidelity.js';
import type { AppearanceSource } from '../document-appearance/resolve.js';

export type RoleFormatting = {
  text: Omit<DocxSetTextFormattingOperation, 'target' | 'baseRevision'>;
  paragraph: Omit<DocxSetParagraphFormattingOperation, 'target' | 'baseRevision'>;
};
export interface StyleApplicationPlan {
  roles: Record<string, RoleFormatting>;
  page: { topMarginTwips?: number; rightMarginTwips?: number; bottomMarginTwips?: number; leftMarginTwips?: number; paperSize?: 'letter' | 'a4'; orientation?: 'portrait' | 'landscape' };
  table?: {
    formatting: Omit<DocxSetTableFormattingOperation, 'table' | 'baseRevision'>;
    headerFill?: string;
    headerTextColor?: string;
    headerBold?: boolean;
    widthTwips?: number;
  };
  logo?: { imageBytes: Uint8Array };
  unsupported: string[];
}

export function styleApplicationFields(plan: StyleApplicationPlan): string[] {
  return [
    ...Object.entries(plan.roles).flatMap(([name, role]) => [
      ...Object.keys(role.text).map((field) => `${name}.text.${field}`),
      ...Object.keys(role.paragraph).map((field) => `${name}.paragraph.${field}`),
    ]),
    ...Object.keys(plan.page).map((field) => field === 'paperSize' ? 'page.size' : field === 'orientation' ? 'page.orientation' : `page.margins.${field.replace('MarginTwips', '')}`),
    ...(plan.table ? [
      ...Object.keys(plan.table.formatting).map((field) => field === 'borders' ? 'table.borders' : field === 'alignment' ? 'table.alignment' : `table.padding.${field.replace('cellMargin', '').replace('Twips', '').toLowerCase()}`),
      ...(plan.table.headerFill ? ['table.headerFill'] : []),
      ...(plan.table.headerTextColor ? ['table.headerTextColor'] : []),
      ...(plan.table.headerBold ? ['table.headerBold'] : []),
      ...(plan.table.widthTwips ? ['table.columnWidthTotal'] : []),
    ] : []),
    ...(plan.logo ? ['logo'] : []),
  ];
}
const sides = ['top', 'right', 'bottom', 'left'] as const;
const color = (value: unknown) => typeof value === 'string' && /^(?:[0-9a-f]{6}|auto)$/i.test(value);
const integer = (value: unknown, min = 0, max = 31680) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Translate only values that the current N-API can express. Never invent absent facts. */
export function buildStyleApplicationPlan(style: StyleProfileData): StyleApplicationPlan {
  const plan: StyleApplicationPlan = { roles: {}, page: {}, unsupported: [] };
  function role(name: string, value: StyleRole) {
    const result: RoleFormatting = { text: {}, paragraph: {} };
    for (const [field, fact] of Object.entries(value.text)) {
      const supported = field === 'fontFamily' ? typeof fact === 'string' && !!fact.trim()
        : field === 'fontSizeHalfPoints' ? integer(fact, 1, 1638)
        : field === 'color' ? color(fact)
        : ['bold', 'italic', 'underline', 'strikethrough'].includes(field) ? typeof fact === 'boolean'
        : field === 'highlight' ? typeof fact === 'string' && /^(black|blue|cyan|green|magenta|red|yellow|white|darkBlue|darkCyan|darkGreen|darkMagenta|darkRed|darkYellow|darkGray|lightGray|none)$/.test(fact)
        : field === 'verticalAlignment' && ['baseline', 'superscript', 'subscript'].includes(String(fact));
      if (supported) Object.assign(result.text, { [field]: field === 'color' && fact !== 'auto' ? String(fact).toUpperCase() : fact });
      else plan.unsupported.push(`${name}.text.${field}`);
    }
    for (const [field, fact] of Object.entries(value.paragraph)) {
      const supported = field === 'alignment' ? ['left', 'center', 'right'].includes(String(fact))
        : ['spacingBeforeTwips', 'spacingAfterTwips'].includes(field) ? integer(fact)
        : field === 'leftIndentTwips' && integer(fact, -31680);
      if (supported) Object.assign(result.paragraph, { [field]: fact });
      else plan.unsupported.push(`${name}.paragraph.${field}`);
    }
    plan.roles[name] = result;
  }
  role('body', style.body);
  if (style.title) role('Title', style.title);
  for (const heading of style.headings.filter(h => h.level >= 1 && h.level <= 3).sort((a, b) => a.level - b.level)) role(`Heading${heading.level}`, heading);
  for (const heading of style.headings.filter(h => h.level > 3)) plan.unsupported.push(`Heading${heading.level}`);
  if (style.page) {
    for (const [side, fact] of Object.entries(style.page.marginsTwips)) {
      if (sides.includes(side as typeof sides[number]) && integer(fact)) Object.assign(plan.page, { [`${side}MarginTwips`]: fact });
      else plan.unsupported.push(`page.margins.${side}`);
    }
    const { pageWidthTwips: width, pageHeightTwips: height, orientation } = style.page;
    const dimensions = [width, height].sort((a, b) => (a ?? 0) - (b ?? 0));
    if (width !== undefined || height !== undefined) {
      if (dimensions[0] === 12240 && dimensions[1] === 15840) plan.page.paperSize = 'letter';
      else if (dimensions[0] === 11906 && dimensions[1] === 16838) plan.page.paperSize = 'a4';
      else plan.unsupported.push('page.size');
      // A landscape size cannot be reproduced without a known orientation.
      if (width && height && width > height && !orientation) { delete plan.page.paperSize; plan.unsupported.push('page.orientation'); }
    }
    if (orientation === 'portrait' || orientation === 'landscape') plan.page.orientation = orientation;
    else if (orientation) plan.unsupported.push('page.orientation');
    if (style.page.differentFirstPage || style.page.oddEvenHeaders || style.page.pageNumberFormat || style.page.pageNumberStart !== undefined) plan.unsupported.push('page.headerFooterSettings');
  }
  if (style.table) {
    const table = style.table;
    const formatting: NonNullable<StyleApplicationPlan['table']>['formatting'] = {};
    if (table.alignment && ['left', 'center', 'right'].includes(table.alignment)) Object.assign(formatting, { alignment: table.alignment });
    else if (table.alignment) plan.unsupported.push('table.alignment');
    for (const [side, fact] of Object.entries(table.cellMarginsTwips)) {
      if (sides.includes(side as typeof sides[number]) && integer(fact)) Object.assign(formatting, { [`cellMargin${side[0]!.toUpperCase()}${side.slice(1)}Twips`]: fact });
      else plan.unsupported.push(`table.padding.${side}`);
    }
    const borderSides = ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'];
    if (table.borders.length === 6 && borderSides.every(side => table.borders.some(b => b.side === side && b.style === 'single' && b.color === 'auto' && b.sizeEighthPoints === 4))) Object.assign(formatting, { borders: 'grid' });
    else if (table.borders.length) plan.unsupported.push('table.borders');
    plan.table = { formatting };
    if (table.headerFills.length === 1 && color(table.headerFills[0]) && table.headerFills[0] !== 'auto') plan.table.headerFill = table.headerFills[0]!.toUpperCase();
    else if (table.headerFills.length) plan.unsupported.push('table.headerFill');
    // Positive observed emphasis is evidence; absence of bold runs is not an explicit false.
    if (table.headerHasBoldText) plan.table.headerBold = true;
    if (table.widthType === 'dxa' && integer(table.widthTwips, 1)) { plan.table.widthTwips = table.widthTwips; plan.unsupported.push('table.widthDeclaration'); }
    else if (table.widthTwips !== undefined || table.widthType) plan.unsupported.push('table.width');
  }
  if (style.lists.length) plan.unsupported.push('lists.markerAndIndent');
  if (style.headersFooters.present) plan.unsupported.push('headersFooters');
  if (style.unresolvedThemeReferences.length) plan.unsupported.push('unresolvedThemeReferences');
  if (style.evidence.truncated) plan.unsupported.push('partialSourceEvidence');
  plan.unsupported = [...new Set(plan.unsupported)].sort();
  return plan;
}

async function inspectContent(binding: DocxEngineBinding, bytes: Uint8Array) {
  const paragraphs: DocxInspectParagraphItem[] = [];
  const tables: DocxInspectTableItem[] = [];
  for (const kind of ['paragraphs', 'tables'] as const) {
    for (let offset = 0; ; offset += 100) {
      const result = await binding.inspectDocx(bytes, { focus: { kind, offset, limit: 100 } });
      const page = result[kind];
      if (!result.ok || !page) throw new StyleProfileError(422, 'STYLE_TARGET_INSPECTION_FAILED', 'Could not inspect style targets');
      if (kind === 'paragraphs') paragraphs.push(...result.paragraphs!.items);
      else tables.push(...result.tables!.items);
      if (!page.page.hasMore) break;
      if (offset >= 9900) throw new StyleProfileError(422, 'STYLE_TARGET_TOO_LARGE', 'Style application supports at most 10,000 inspected items');
    }
  }
  return { paragraphs, tables };
}

const logoMaxWidthEmu = 1_371_600; // 1.5 inches
const logoMaxHeightEmu = 457_200; // 0.5 inches

async function firstBodyPicture(binding: DocxEngineBinding, bytes: Uint8Array) {
  const result = await binding.inspectDocx(bytes, { focus: { kind: 'body_blocks', offset: 0, limit: 1 } });
  const block = result.bodyBlocks?.items[0];
  return result.ok && block?.kind === 'picture' ? block.picture : undefined;
}

function modestLogoSize(widthEmu: number, heightEmu: number) {
  if (!Number.isFinite(widthEmu) || !Number.isFinite(heightEmu) || widthEmu <= 0 || heightEmu <= 0) return;
  const widthScale = logoMaxWidthEmu / widthEmu;
  const heightScale = logoMaxHeightEmu / heightEmu;
  const scale = Math.min(1, widthScale, heightScale);
  if (scale === 1) return;
  // The engine accepts one dimension and derives the other to preserve aspect ratio.
  return widthScale <= heightScale
    ? { widthEmu: Math.floor(widthEmu * scale) }
    : { heightEmu: Math.floor(heightEmu * scale) };
}

/** Stage through the same bound engine host. The caller adopts bytes only after verification. */
export async function applyStylePlan(binding: DocxEngineBinding, bytes: Uint8Array, plan: StyleApplicationPlan, provenance: Readonly<Record<string, AppearanceSource>> = {}): Promise<{ bytes: Uint8Array; fidelity: StyleFidelityReport; operationCount: number }> {
  const before = await inspectContent(binding, bytes);
  const initialStyle = await inspectDocxStyleSnapshot(bytes, binding);
  if (!initialStyle.ok) throw new StyleProfileError(422, 'STYLE_INSPECTION_FAILED', 'Could not inspect target styles');
  const host = bindDocxDocument({ binding, bytes });
  let operationCount = 0;
  const unsupported = [...plan.unsupported];
  let logoWasApplied = false;
  let logoInserted = false;
  let headerTextStatus: StyleFidelityReport['fields'][number]['status'] | undefined;
  async function mutate(capability: string, operation: Record<string, unknown>) {
    const result = await host.mutate(capability, operation);
    if (!result.ok) throw new StyleProfileError(422, result.reasonCode ?? 'STYLE_APPLICATION_FAILED', `Style application failed: ${result.reasonCode ?? capability}`);
    operationCount++;
  }
  if (Object.keys(plan.page).length) {
    if (initialStyle.sectionCount > 1) unsupported.push('page.multipleSections');
    else await mutate('set_page_setup', plan.page);
  }
  if (plan.logo) {
    try {
      await mutate('insert_picture', { imageBytes: Buffer.from(plan.logo.imageBytes), placement: { kind: 'start' } });
      logoInserted = true;
      const picture = await firstBodyPicture(binding, host.currentBytes());
      const size = picture && modestLogoSize(picture.widthEmu, picture.heightEmu);
      if (!picture) throw new Error('Could not verify inserted workspace logo');
      if (size) {
        await mutate('set_picture_size', { handle: picture.handle, ...size });
      }
      logoWasApplied = true;
    } catch (error) {
      if (logoInserted) throw error;
      console.warn('[style-application] workspace logo unavailable', error);
      unsupported.push('logo');
    }
  }
  const searches = new Map<string, Awaited<ReturnType<DocxEngineBinding['findDocxText']>>>();
  for (const paragraph of before.paragraphs) {
    // Only mutable direct body paragraphs. Table cells use their own handle-based API.
    if (paragraph.targetOccurrence === undefined || !paragraph.handle || !paragraph.text) continue;
    const styleId = initialStyle.styles.find(style => style.name === paragraph.styleName || style.styleId === paragraph.styleName)?.styleId;
    const name = paragraphRole(paragraph.styleName, styleId);
    const role = plan.roles[name];
    if (!role) continue;
    let found = searches.get(paragraph.text);
    if (!found) { found = await binding.findDocxText(bytes, { text: paragraph.text }); searches.set(paragraph.text, found); }
    const exact = before.paragraphs.filter(p => p.text === paragraph.text);
    const bodyMatches = found.matches.filter(m => m.container === 'paragraph');
    // Whole-paragraph text must not also match a substring or an uninspected container.
    if (!found.ok || bodyMatches.length !== exact.length || bodyMatches.some(m => m.before || m.after) || exact.some(p => p.targetOccurrence === undefined)) {
      unsupported.push(`${name}.unsafeTextTarget`);
      continue;
    }
    const textOccurrence = bodyMatches[paragraph.targetOccurrence]!.occurrence;
    if (Object.keys(role.text).length) await mutate('set_text_formatting', { ...role.text, target: { text: paragraph.text, occurrence: textOccurrence } });
    const paragraphFormatting = { ...role.paragraph };
    if (paragraph.list) delete paragraphFormatting.leftIndentTwips;
    if (Object.keys(paragraphFormatting).length) await mutate('set_paragraph_formatting', { ...paragraphFormatting, target: { text: paragraph.text, occurrence: paragraph.targetOccurrence } });
  }
  const tableText = Object.fromEntries(Object.entries(plan.roles.body!.text).filter(([field]) => ['fontFamily', 'fontSizeHalfPoints', 'color', 'bold', 'italic'].includes(field)));
  for (const table of before.tables) {
    if (!table.isRectangular || table.affordances?.some(a => a.capability === 'set_table_cells_formatting' && !a.supported)) { unsupported.push('table.complexTarget'); continue; }
    const target = { handle: table.handle };
    if (plan.table && Object.keys(plan.table.formatting).length) await mutate('set_table_formatting', { ...plan.table.formatting, table: target });
    if (plan.table?.widthTwips) {
      // Preserve target column proportions; the profile stores total width, not source columns.
      const current = initialStyle.tables.find(t => t.index === table.occurrence);
      const widths = current?.columnWidthsTwips;
      if (!(current?.widthType === 'dxa' && current.widthTwips !== plan.table.widthTwips) && widths?.length === table.columns.length && widths.every(w => w > 0)) {
        const total = widths.reduce((sum, w) => sum + w, 0);
        const scaled = widths.map(w => Math.max(1, Math.round(w / total * plan.table!.widthTwips!)));
        scaled[scaled.length - 1]! += plan.table.widthTwips - scaled.reduce((sum, w) => sum + w, 0);
        if (scaled.every(w => w > 0)) await mutate('set_table_column_widths', { table: target, widthsTwips: scaled });
        else unsupported.push('table.width');
      } else unsupported.push('table.width');
    }
    const updates = table.rows.flatMap((row, rowIndex) => row.cellHandles.map(handle => ({
      target: { handle },
      ...(rowIndex === 0 && plan.table?.headerFill ? { fill: plan.table.headerFill } : {}),
      textFormatting: {
        ...tableText,
        ...(rowIndex === 0 && plan.table?.headerTextColor ? { color: plan.table.headerTextColor } : {}),
        ...(rowIndex === 0 && plan.table?.headerBold ? { bold: true } : {}),
      },
    })));
    const supportedUpdates = updates.filter(update => 'fill' in update || Object.keys(update.textFormatting).length);
    if (supportedUpdates.length) {
      await mutate('set_table_cells_formatting', { table: target, updates: supportedUpdates });
      if (plan.table?.headerTextColor) headerTextStatus = 'matched';
    }
  }
  const output = host.currentBytes();
  const after = await inspectContent(binding, output);
  // Inline pictures use an empty paragraph anchor. It is layout, not document text.
  const content = (value: typeof before) => ({ paragraphs: value.paragraphs.filter(p => p.text).map(p => ({ text: p.text, styleName: p.styleName, list: p.list })), tables: value.tables.map(t => ({ rows: t.rows.map(r => r.cells), rowCount: t.rowCount, columns: t.columns.map(c => c.text) })) });
  if (JSON.stringify(content(before)) !== JSON.stringify(content(after))) throw new StyleProfileError(422, 'STYLE_CONTENT_CHANGED', 'Style application changed document content or roles');
  const snapshot = await inspectDocxStyleSnapshot(output, binding);
  if (!snapshot.ok) throw new StyleProfileError(422, 'STYLE_INSPECTION_FAILED', 'Could not verify applied style');
  const fidelity = compareStyleFidelity(plan, snapshot, unsupported, provenance);
  if (plan.table?.headerTextColor) {
    const status = snapshot.truncated ? 'unsupported' : !before.tables.length ? 'not_applicable'
      : before.tables.some(table => !table.isRectangular || table.affordances?.some(a => a.capability === 'set_table_cells_formatting' && !a.supported)) ? 'unsupported'
      : headerTextStatus ?? 'mismatched';
    appendStyleFidelityField(fidelity, 'table.headerTextColor', status, provenance);
  }
  if (plan.logo && !unsupported.includes('logo')) {
    const picture = await firstBodyPicture(binding, output);
    appendStyleFidelityField(fidelity, 'logo', logoWasApplied && picture
      && picture.widthEmu <= logoMaxWidthEmu && picture.heightEmu <= logoMaxHeightEmu ? 'matched' : 'mismatched', provenance);
  }
  return { bytes: output, operationCount, fidelity };
}

export async function applyStyleProfileToDocument(input: {
  profileId: string; ownerUserId: string; workspaceId: string;
  documentId: string; versionId: string; bytes: Uint8Array;
  profiles: Pick<StyleProfileService, 'get'>;
  documents: Pick<DocumentService, 'getOwnedDocument'>;
  binding: DocxEngineBinding;
}) {
  const profile = await input.profiles.get(input.ownerUserId, input.profileId);
  const document = await input.documents.getOwnedDocument({ documentId: input.documentId, ownerUserId: input.ownerUserId });
  if (document.workspaceId !== input.workspaceId || document.format !== 'docx') throw new StyleProfileError(404, 'DOCUMENT_NOT_FOUND', 'Editable DOCX not found in this workspace');
  if (document.latestVersion.id !== input.versionId) throw new StyleProfileError(409, 'VERSION_CONFLICT', 'Document version changed before style application');
  const result = await applyStylePlan(input.binding, input.bytes, buildStyleApplicationPlan(profile.style));
  return { ...result, profileId: profile.id, profileName: profile.name, style: profile.style, documentId: document.id };
}

/** Field details stay in API verification; the model sees bounded groups and counts. */
export function styleApplicationSummary(result: { profileId: string; profileName: string; documentId: string; fidelity: StyleFidelityReport }) {
  return { profileId: result.profileId, profileName: result.profileName, documentId: result.documentId, ...result.fidelity.summary };
}
