import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocxStyleSnapshot } from '@opensuite/engine-client';
import { normalizeStyleSnapshot } from './normalize.js';

export function snapshotFixture(): DocxStyleSnapshot {
  return {
    ok: true, schemaVersion: 1, paragraphCount: 10, runCount: 10, tableCount: 0, sectionCount: 1,
    defaults: { defaultParagraphStyleId: 'Normal', runFormatting: { fontFamily: 'Arial', fontSizeHalfPoints: 22 }, paragraphFormatting: { spacingAfterTwips: 160 } },
    styles: [{ styleId: 'Normal', styleType: 'paragraph', paragraphUsageCount: 8, runUsageCount: 8, declaredRunFormatting: {}, declaredParagraphFormatting: {} }, { styleId: 'Heading2', name: 'Heading 2', styleType: 'paragraph', paragraphUsageCount: 2, runUsageCount: 2, declaredRunFormatting: { bold: true, fontSizeHalfPoints: 28 }, declaredParagraphFormatting: { spacingAfterTwips: 100 } }],
    typography: { fonts: [{ value: 'Arial', count: 10 }], fontSizesHalfPoints: [], textColors: [{ value: 'FF0000', count: 1 }], highlights: [], boldRunCount: 1, italicRunCount: 0, underlineRunCount: 0, runPatterns: [
      { paragraphStyleId: 'Normal', directFormatting: {}, effectiveFormatting: { fontFamily: 'Arial', fontSizeHalfPoints: 22 }, usageCount: 7 },
      { paragraphStyleId: 'Normal', directFormatting: { bold: true, color: 'FF0000' }, effectiveFormatting: { fontFamily: 'Arial', fontSizeHalfPoints: 22, bold: true, color: 'FF0000' }, usageCount: 1 },
    ] },
    paragraphPatterns: [{ styleId: 'Normal', directFormatting: { spacingAfterTwips: 40 }, effectiveFormatting: { spacingAfterTwips: 40 }, usageCount: 7, locations: ['body'] }],
    lists: [{ numberingId: 1, level: 0, format: 'bullet', text: '•', leftIndentTwips: 720, hangingIndentTwips: 360, usageCount: 3 }],
    tables: [], sections: [{ index: 0, pageWidthTwips: 12240, pageHeightTwips: 15840, marginsTwips: { left: 1440, right: 1440 }, differentFirstPage: false, oddEvenHeaders: false }],
    headersFooters: [], themeReferences: [], truncated: false, diagnostics: [],
  };
}

test('normalization is deterministic including input collection order and repeated body spacing', () => {
  const s = snapshotFixture();
  const profile = normalizeStyleSnapshot(s);
  assert.deepEqual(profile, normalizeStyleSnapshot(s));
  assert.deepEqual(profile, normalizeStyleSnapshot({ ...s, styles: [...s.styles].reverse(), typography: { ...s.typography, runPatterns: [...s.typography.runPatterns].reverse() } }));
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.body.text.fontFamily, 'Arial');
  assert.equal(profile.body.paragraph.spacingAfterTwips, 40);
  assert.equal(profile.headings[0]?.level, 2);
  assert.equal(profile.headings[0]?.text.fontSizeHalfPoints, 28);
  assert.equal(profile.body.text.bold, undefined);
  assert.equal(profile.body.text.color, undefined);
  assert.deepEqual(profile.palette.text, []);
  assert.equal(profile.emphasis[0]?.repeated, false);
  assert.equal(profile.lists[0]?.leftIndentTwips, 720);
  assert.equal(profile.page?.orientation, undefined);
  assert.equal(profile.page?.orientationSource, 'unknown');
  assert.equal(profile.headersFooters.present, false);
});

test('table-dominant formatting is not body typography or body spacing; structural headers survive', () => {
  const s = snapshotFixture();
  const table: DocxStyleSnapshot['tables'][number] = { index: 0, columnWidthsTwips: [4000], borders: [{ side: 'top', color: 'auto', style: 'single' }], cellMarginsTwips: { left: 120 }, shadingColors: [{ value: 'DCE3EA', count: 2 }], borderColors: [{ value: 'auto', count: 4 }], mergedCellCount: 0, rowCount: 8, columnCount: 1, firstRowShadingColors: ['DCE3EA'], firstRowBoldRunCount: 2, hasComplexStructure: false };
  const p = normalizeStyleSnapshot({ ...s, tableCount: 1, tables: [table], typography: { ...s.typography, runPatterns: [...s.typography.runPatterns, { directFormatting: { bold: true, color: 'FF0000', fontFamily: 'Table Font' }, usageCount: 100 }] }, paragraphPatterns: [...s.paragraphPatterns, { directFormatting: { spacingAfterTwips: 0 }, usageCount: 100, locations: ['table_cell'] }] });
  assert.equal(p.body.text.fontFamily, 'Arial');
  assert.equal(p.body.text.bold, undefined);
  assert.equal(p.body.paragraph.spacingAfterTwips, 40);
  assert.equal(p.table?.headerFills[0], 'DCE3EA');
  assert.equal(p.table?.headerHasBoldText, true);
  assert.equal(p.table?.cellMarginsTwips.left, 120);
});

test('repeated body typography wins; ties and isolated overrides do not', () => {
  const s = snapshotFixture();
  const p = normalizeStyleSnapshot({ ...s, typography: { ...s.typography, runPatterns: [ { paragraphStyleId: 'Normal', directFormatting: { fontFamily: 'Calibri' }, usageCount: 4 }, { paragraphStyleId: 'Normal', directFormatting: { fontFamily: 'Other' }, usageCount: 2 } ] } });
  assert.equal(p.body.text.fontFamily, 'Calibri');
  assert.equal(p.emphasis[0]?.repeated, true);
  const tie = normalizeStyleSnapshot({ ...s, typography: { ...s.typography, runPatterns: [ { paragraphStyleId: 'Normal', directFormatting: { fontFamily: 'Calibri' }, usageCount: 2 }, { paragraphStyleId: 'Normal', directFormatting: { fontFamily: 'Other' }, usageCount: 2 } ] } });
  assert.equal(tie.body.text.fontFamily, 'Arial');
});

test('unresolved theme references, diagnostics, and partial evidence remain explicit', () => {
  const s = snapshotFixture();
  const p = normalizeStyleSnapshot({ ...s, truncated: true, themeReferences: [{ property: 'color', value: 'accent1', count: 2 }], diagnostics: [{ code: 'UNRESOLVED_THEME', message: 'Theme unresolved' }] });
  assert.equal(p.unresolvedThemeReferences[0]?.value, 'accent1');
  assert.equal(p.diagnostics[0]?.code, 'UNRESOLVED_THEME');
  assert.equal(p.evidence.truncated, true);
  assert.ok(p.diagnostics.some(d => d.code === 'PROFILE_PARTIAL_SNAPSHOT'));
  assert.throws(() => normalizeStyleSnapshot({ ...s, ok: false }));
});

test('a repeated custom body style is selected when the default style is unused', () => {
  const s = snapshotFixture();
  const p = normalizeStyleSnapshot({ ...s,
    styles: [...s.styles, { styleId: 'BodyText', name: 'Body Text', styleType: 'paragraph', paragraphUsageCount: 4, runUsageCount: 4, declaredRunFormatting: { fontFamily: 'Calibri' }, declaredParagraphFormatting: { spacingAfterTwips: 80 } }],
    paragraphPatterns: [{ styleId: 'BodyText', directFormatting: {}, usageCount: 4, locations: ['body'] }],
    typography: { ...s.typography, runPatterns: [{ paragraphStyleId: 'BodyText', directFormatting: {}, usageCount: 4 }] },
  });
  assert.equal(p.body.styleId, 'BodyText');
  assert.equal(p.body.text.fontFamily, 'Calibri');
  assert.equal(p.body.paragraph.spacingAfterTwips, 80);
});

test('named body runs shared with table cells remain ambiguous', () => {
  const s = snapshotFixture();
  const p = normalizeStyleSnapshot({ ...s, tableCount: 1,
    typography: { ...s.typography, runPatterns: [{ paragraphStyleId: 'Normal', directFormatting: { fontFamily: 'Table Font', bold: true }, usageCount: 20 }] },
    paragraphPatterns: [{ styleId: 'Normal', directFormatting: {}, usageCount: 20, locations: ['body', 'table_cell'] }],
  });
  assert.equal(p.body.text.fontFamily, 'Arial');
  assert.equal(p.body.text.bold, undefined);
  assert.ok(p.diagnostics.some(d => d.code === 'PROFILE_RUN_LOCATION_LIMIT'));
});
