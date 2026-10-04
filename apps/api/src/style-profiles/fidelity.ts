import type { DocxStyleSnapshot } from '@opensuite/engine-client';
import type { StyleApplicationPlan } from './application.js';
import type { AppearanceSource } from '../document-appearance/resolve.js';
import { paragraphRole } from './normalize.js';

export type StyleFidelityStatus = 'matched' | 'mismatched' | 'not_applicable' | 'unsupported';
export interface StyleFidelityReport {
  fields: { field: string; status: StyleFidelityStatus; source?: AppearanceSource }[];
  summary: { matched: string[]; mismatched: string[]; notApplicable: string[]; unsupported: string[]; counts: Record<StyleFidelityStatus, number> };
}

function summary(fields: StyleFidelityReport['fields']): StyleFidelityReport['summary'] {
  const counts: Record<StyleFidelityStatus, number> = { matched: 0, mismatched: 0, not_applicable: 0, unsupported: 0 };
  for (const item of fields) counts[item.status]++;
  const groups = (status: StyleFidelityStatus) => [...new Set(fields.filter(f => f.status === status).map(f => f.field.split('.')[0]!))].slice(0, 12);
  return { matched: groups('matched'), mismatched: groups('mismatched'), notApplicable: groups('not_applicable'), unsupported: [...new Set(fields.filter(f => f.status === 'unsupported').map(f => f.field))].slice(0, 20), counts };
}

export function appendStyleFidelityField(report: StyleFidelityReport, field: string, status: StyleFidelityStatus, provenance: Readonly<Record<string, AppearanceSource>> = {}) {
  report.fields.push({ field, status, ...(provenance[field] ? { source: provenance[field] } : {}) });
  report.summary = summary(report.fields);
}

/** Compare every observed effective pattern, never just a dominant normalized value. */
export function compareStyleFidelity(plan: StyleApplicationPlan, snapshot: DocxStyleSnapshot, unresolved = plan.unsupported, provenance: Readonly<Record<string, AppearanceSource>> = {}): StyleFidelityReport {
  if (!snapshot.ok) throw new Error('Style fidelity requires a successful style snapshot');
  const fields: StyleFidelityReport['fields'] = [];
  function add(field: string, status: StyleFidelityStatus) {
    fields.push({ field, status, ...(provenance[field] ? { source: provenance[field] } : {}) });
  }
  function compare(field: string, expected: unknown, values: unknown[]) {
    add(field, snapshot.truncated ? 'unsupported' : !values.length ? 'not_applicable' : values.every(value => JSON.stringify(value) === JSON.stringify(expected)) ? 'matched' : 'mismatched');
  }
  const styleNames = new Map(snapshot.styles.map(s => [s.styleId, s.name ?? s.styleId]));
  const roleForId = (id = snapshot.defaults.defaultParagraphStyleId) => paragraphRole(styleNames.get(id ?? ''), id);
  for (const [name, role] of Object.entries(plan.roles)) {
    const paragraphs = snapshot.paragraphPatterns.filter(p => p.locations.includes('body') && roleForId(p.styleId) === name);
    const bodyIds = new Set(paragraphs.map(p => p.styleId ?? snapshot.defaults.defaultParagraphStyleId));
    const runs = snapshot.typography.runPatterns.filter(p => bodyIds.has(p.paragraphStyleId ?? snapshot.defaults.defaultParagraphStyleId));
    for (const [field, value] of Object.entries(role.text)) {
      // Run patterns do not retain locations. Table header emphasis cannot prove body emphasis.
      if (name === 'body' && snapshot.tableCount && ['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'verticalAlignment'].includes(field)) {
        add(`${name}.text.${field}`, 'unsupported');
      } else compare(`${name}.text.${field}`, value, runs.map(p => (p.effectiveFormatting ?? p.directFormatting)[field as keyof typeof p.directFormatting]));
    }
    for (const [field, value] of Object.entries(role.paragraph)) {
      if (name === 'body' && snapshot.lists.length && field === 'leftIndentTwips') add('body.paragraph.leftIndentTwips', 'unsupported');
      else compare(`${name}.paragraph.${field}`, value, paragraphs.map(p => (p.effectiveFormatting ?? p.directFormatting)[field as keyof typeof p.directFormatting]));
    }
  }
  for (const [field, value] of Object.entries(plan.page)) {
    if (field === 'paperSize') {
      const size = value === 'letter' ? [12240, 15840] : [11906, 16838];
      compare('page.size', size, snapshot.sections.map(s => [s.pageWidthTwips, s.pageHeightTwips].sort((a, b) => (a ?? 0) - (b ?? 0))));
    } else if (field === 'orientation') compare('page.orientation', value, snapshot.sections.map(s => s.orientation));
    else compare(`page.margins.${field.replace('MarginTwips', '')}`, value, snapshot.sections.map(s => s.marginsTwips[field.replace('MarginTwips', '')]));
  }
  if (plan.table) {
    const tables = snapshot.tables.filter(t => !t.hasComplexStructure);
    for (const [field, value] of Object.entries(plan.table.formatting)) {
      if (field === 'borders') {
        compare('table.borders', true, tables.map(t => ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'].every(side => t.borders.some(b => b.side === side && b.style === 'single' && b.color === 'auto' && b.sizeEighthPoints === 4))));
      } else if (field === 'alignment') compare('table.alignment', value, tables.map(t => t.alignment));
      else {
        const side = field.replace('cellMargin', '').replace('Twips', '').toLowerCase();
        compare(`table.padding.${side}`, value, tables.map(t => t.cellMarginsTwips[side]));
      }
    }
    if (plan.table.headerFill) compare('table.headerFill', true, tables.map(t => t.firstRowShadingColors.length > 0 && t.firstRowShadingColors.every(fill => fill === plan.table!.headerFill)));
    if (plan.table.headerBold) compare('table.headerBold', true, tables.map(t => t.firstRowBoldRunCount >= t.columnCount));
    if (plan.table.widthTwips) compare('table.columnWidthTotal', plan.table.widthTwips, tables.map(t => t.columnWidthsTwips.reduce((sum, width) => sum + width, 0)));
  }
  if (!plan.table) add('table', 'not_applicable');
  if (!unresolved.includes('headersFooters')) add('headersFooters', 'not_applicable');
  for (const field of [...new Set(unresolved)].sort()) {
    const absent = field === 'headersFooters' ? !snapshot.headersFooters.length
      : field.startsWith('lists.') ? !snapshot.lists.length
      : field.startsWith('table.') ? !snapshot.tableCount : false;
    add(field, absent && !snapshot.truncated ? 'not_applicable' : 'unsupported');
  }
  return { fields, summary: summary(fields) };
}
