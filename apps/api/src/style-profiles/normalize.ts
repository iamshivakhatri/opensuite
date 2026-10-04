import type { StyleProfileData, StyleRole, StyleTextFormatting } from '@opensuite/contracts';
import type { DocxStyleSnapshot, DocxStyleUsageSnapshot } from '@opensuite/engine-client';

// Canonical keys provide stable ties and JSON output even when input order changes.
function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${key(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function ranked<T>(items: readonly { value: T; count: number }[]) {
  const groups = new Map<string, { value: T; count: number }>();
  for (const item of items) {
    const id = key(item.value);
    const group = groups.get(id);
    if (group) group.count += item.count;
    else groups.set(id, { value: item.value, count: item.count });
  }
  return [...groups.entries()].sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}
function repeatedFields<T extends object>(base: T, patterns: { value: T; count: number }[]): T {
  const result = { ...base };
  const total = patterns.reduce((sum, p) => sum + p.count, 0);
  const fields = new Set(patterns.flatMap(p => Object.keys(p.value)));
  for (const field of fields) {
    const values = ranked(patterns.filter(p => field in p.value).map(p => ({ value: p.value[field as keyof T], count: p.count })));
    const winner = values[0];
    // Two observations and a strict majority. Missing facts count against promotion.
    if (winner && winner.count >= 2 && winner.count > total / 2) result[field as keyof T] = winner.value!;
  }
  return result;
}
const colors = (items: readonly { value: string; count: number }[]) => ranked(items).slice(0, 6).map(x => x.value);
const unique = (items: readonly string[]) => [...new Set(items)].sort();

/** Only structured engine facts. No time, IDs, document text, or model decisions. */
export function normalizeStyleSnapshot(snapshot: DocxStyleSnapshot): StyleProfileData {
  if (!snapshot.ok || snapshot.schemaVersion !== 1) throw new Error('Style inspection did not return a supported successful snapshot');
  const paragraphStyles = snapshot.styles.filter(s => s.styleType === 'paragraph');
  const isHeading = (s: DocxStyleUsageSnapshot) => /^(heading)\s*([1-9])$/i.test(s.name ?? s.styleId) || /^heading[1-9]$/i.test(s.styleId);
  const isTitle = (s: DocxStyleUsageSnapshot) => /^title$/i.test(s.name ?? s.styleId);
  // The engine's default body style is safer than globally dominant table/header runs.
  const bodyPatterns = snapshot.paragraphPatterns.filter(p => p.locations.length === 1 && p.locations[0] === 'body');
  const defaultStyle = paragraphStyles.find(s => s.styleId === snapshot.defaults.defaultParagraphStyleId);
  const usesDefaultBody = bodyPatterns.some(p => !p.styleId || p.styleId === snapshot.defaults.defaultParagraphStyleId);
  const bodyCandidates = paragraphStyles.filter(s => !isHeading(s) && !isTitle(s));
  const bodyStyle = usesDefaultBody ? defaultStyle : bodyCandidates.map(style => ({ style, count: bodyPatterns.filter(p => p.styleId === style.styleId).reduce((n, p) => n + p.usageCount, 0) })).filter(s => s.count > 0).sort((a, b) => b.count - a.count || a.style.styleId.localeCompare(b.style.styleId))[0]?.style ?? defaultStyle;
  function role(style?: DocxStyleUsageSnapshot, body = false): StyleRole {
    const bodyId = style?.styleId ?? snapshot.defaults.defaultParagraphStyleId;
    const matches = (id?: string) => body ? id === bodyId || !id : id === style?.styleId;
    // Run patterns have no location: unstyled runs in a table document are ambiguous.
    const runs = snapshot.typography.runPatterns.filter(pattern => {
      if (!matches(pattern.paragraphStyleId)) return false;
      if (!body || snapshot.tableCount === 0) return true;
      if (!pattern.paragraphStyleId) return false;
      return !snapshot.paragraphPatterns.some(paragraph =>
        paragraph.styleId === pattern.paragraphStyleId && paragraph.locations.some(location => location !== 'body'));
    });
    const paragraphs = snapshot.paragraphPatterns.filter(p => matches(p.styleId) && p.locations.length === 1 && p.locations[0] === 'body');
    const baseText = { ...snapshot.defaults.runFormatting, ...(style?.effectiveRunFormatting ?? style?.declaredRunFormatting ?? {}) };
    const baseParagraph = { ...snapshot.defaults.paragraphFormatting, ...(style?.effectiveParagraphFormatting ?? style?.declaredParagraphFormatting ?? {}) };
    const text = repeatedFields(baseText, runs.map(p => ({ value: p.effectiveFormatting ?? { ...baseText, ...p.directFormatting }, count: p.usageCount })));
    const paragraph = repeatedFields(baseParagraph, paragraphs.map(p => ({ value: p.effectiveFormatting ?? { ...baseParagraph, ...p.directFormatting }, count: p.usageCount })));
    return {
      ...(style ? { styleId: style.styleId, name: style.name ?? style.styleId } : {}), text, paragraph,
      evidence: { paragraphCount: paragraphs.reduce((n, p) => n + p.usageCount, 0), runCount: runs.reduce((n, p) => n + p.usageCount, 0), source: style ? 'named_style' : paragraphs.some(p => p.usageCount >= 2) ? 'repeated_body' : 'defaults' },
    };
  }
  const body = role(bodyStyle, true);
  const titleStyle = paragraphStyles.find(s => isTitle(s) && s.paragraphUsageCount > 0);
  const headings = paragraphStyles.filter(s => isHeading(s) && s.paragraphUsageCount > 0).map(s => ({ ...role(s), level: Number((s.styleId.match(/[1-9]/) ?? s.name?.match(/[1-9]/))?.[0]) })).sort((a, b) => a.level - b.level || a.styleId!.localeCompare(b.styleId!)).slice(0, 9);
  const emphasis = ranked(snapshot.typography.runPatterns.filter(p => Object.keys(p.directFormatting).length > 0).map(p => ({ value: p.directFormatting, count: p.usageCount }))).slice(0, 6).map(p => ({ formatting: p.value as StyleTextFormatting, count: p.count, repeated: p.count >= 2 }));
  const tables = ranked(snapshot.tables.filter(t => !t.hasComplexStructure).map(t => ({ count: 1, value: {
    headerFills: unique(t.firstRowShadingColors), headerHasBoldText: t.firstRowBoldRunCount > 0,
    borders: [...t.borders].sort((a, b) => a.side.localeCompare(b.side)), cellMarginsTwips: t.cellMarginsTwips,
    ...(t.widthTwips !== undefined ? { widthTwips: t.widthTwips } : {}), ...(t.widthType ? { widthType: t.widthType } : {}), ...(t.alignment ? { alignment: t.alignment } : {}),
  } })));
  const pages = ranked(snapshot.sections.map(s => ({ count: 1, value: {
    ...(s.pageWidthTwips !== undefined ? { pageWidthTwips: s.pageWidthTwips } : {}), ...(s.pageHeightTwips !== undefined ? { pageHeightTwips: s.pageHeightTwips } : {}),
    ...(s.orientation ? { orientation: s.orientation } : {}), orientationSource: s.orientation ? 'explicit' as const : 'unknown' as const,
    marginsTwips: s.marginsTwips, differentFirstPage: s.differentFirstPage, oddEvenHeaders: s.oddEvenHeaders,
    ...(s.pageNumberStart !== undefined ? { pageNumberStart: s.pageNumberStart } : {}), ...(s.pageNumberFormat ? { pageNumberFormat: s.pageNumberFormat } : {}),
  } })));
  const diagnostics = [...snapshot.diagnostics];
  if (snapshot.tableCount > 0) diagnostics.push({ code: 'PROFILE_RUN_LOCATION_LIMIT', message: 'Run patterns lack locations; ambiguous table/body runs do not set body defaults.' });
  if (tables.length > 1) diagnostics.push({ code: 'PROFILE_TABLE_VARIANTS', message: 'Multiple table treatments observed; the most frequent treatment is retained with its sample count.' });
  if (pages.length > 1) diagnostics.push({ code: 'PROFILE_PAGE_VARIANTS', message: 'Multiple page setups observed; the most frequent setup is retained with its sample count.' });
  if (snapshot.truncated) diagnostics.push({ code: 'PROFILE_PARTIAL_SNAPSHOT', message: 'Inspection was bounded; patterns may have incomplete evidence.' });
  if (snapshot.headersFooters.some(h => h.hasComplexContent)) diagnostics.push({ code: 'PROFILE_COMPLEX_HEADER_FOOTER', message: 'Complex header/footer content is present; only reported typography and page-number facts are retained.' });
  if (snapshot.tables.some(t => t.hasComplexStructure)) diagnostics.push({ code: 'PROFILE_COMPLEX_TABLE', message: 'Complex tables excluded from common table treatment.' });
  if (snapshot.tables.some(t => t.styleId)) diagnostics.push({ code: 'PROFILE_TABLE_INHERITANCE', message: 'Table style inheritance may be unresolved; only observed formatting is retained.' });
  const data: StyleProfileData = {
    schemaVersion: 1, body, ...(titleStyle ? { title: role(titleStyle) } : {}), headings, emphasis,
    palette: { text: colors(snapshot.typography.textColors.filter(c => c.count >= 2)), headings: unique(headings.flatMap(h => h.text.color ? [h.text.color] : [])), tableFills: colors(snapshot.tables.flatMap(t => t.shadingColors)), borders: colors(snapshot.tables.flatMap(t => t.borderColors)) },
    lists: ranked(snapshot.lists.map(l => ({ count: l.usageCount, value: { format: l.format, ...(l.text ? { text: l.text } : {}), ...(l.suffix ? { suffix: l.suffix } : {}), ...(l.leftIndentTwips !== undefined ? { leftIndentTwips: l.leftIndentTwips } : {}), ...(l.hangingIndentTwips !== undefined ? { hangingIndentTwips: l.hangingIndentTwips } : {}) } }))).slice(0, 6).map(l => ({ ...l.value, count: l.count })),
    ...(tables[0] ? { table: { ...tables[0].value, sampleCount: tables[0].count } } : {}),
    ...(pages[0] ? { page: { ...pages[0].value, sampleCount: pages[0].count } } : {}),
    headersFooters: { present: snapshot.headersFooters.length > 0, variants: ranked(snapshot.headersFooters.map(h => ({ count: 1, value: { kind: h.kind, variant: h.variant, hasPageNumber: h.hasPageNumber, fonts: unique(h.fonts), textColors: unique(h.textColors), styleIds: unique(h.styleIds) } }))).slice(0, 6).map(h => h.value) },
    diagnostics, unresolvedThemeReferences: [...snapshot.themeReferences],
    evidence: { paragraphCount: snapshot.paragraphCount, runCount: snapshot.runCount, tableCount: snapshot.tableCount, truncated: snapshot.truncated },
  };
  return JSON.parse(key(data)) as StyleProfileData;
}

export function paragraphRole(name?: string, styleId?: string): string {
  for (const value of [styleId, name]) {
    if (/^title$/i.test(value ?? '')) return 'Title';
    const heading = value?.match(/^heading\s*([1-9])$/i);
    if (heading) return `Heading${heading[1]}`;
  }
  return 'body';
}
