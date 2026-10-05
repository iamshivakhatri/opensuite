import type { DocxEngineBinding, DocxInspectResult, DocxInspectTableItem } from "@opensuite/engine-client";

export interface DocumentCheck {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail" | "skipped";
  readonly message: string;
  readonly evidence?: string;
}

/** Failures that must not present as a clean successful document update. */
export const BLOCKING_VERIFICATION_IDS = new Set([
  "open",
  "target",
  "task",
  "comments",
  "revisions",
  "fields",
  "verification",
]);

const SECTION_MUTATION = /^document\.(?:insert_section_break|set_section_properties|set_section_header_footer|set_odd_even_headers)$/;
const COMMENT_MUTATION = /^document\.(?:add_comment|update_comment|delete_comment)$/;
const REVISION_MUTATION = /^document\.(?:insert_tracked_text|delete_tracked_text|replace_text_with_tracked_change|accept_revision|reject_revision)$/;
const FIELD_MUTATION = /^document\.(?:insert_fields|insert_toc|refresh_fields)$/;

function tocNeedsRefresh(field: {
  kind: string;
  dirty: boolean | null;
  cachedResult: string | null;
}): boolean {
  if (field.kind !== "toc") return false;
  if (field.dirty === true) return true;
  const cached = (field.cachedResult ?? "").trim();
  if (!cached) return true;
  return /update this table of contents|right-click|update field|refresh/i.test(cached);
}

export function hasBlockingVerificationFailure(checks: readonly DocumentCheck[]): boolean {
  return checks.some((check) => check.status === "fail" && BLOCKING_VERIFICATION_IDS.has(check.id));
}

const months = "January February March April May June July August September October November December".split(" ");
const periodToken = () => new RegExp(`\\b(?:${months.join("|")}|Q[1-4])(?:\\s+(?:19|20)\\d{2})?\\b|\\b(?:19|20)\\d{2}\\b`, "gi");
const periodAnchorLine = /reporting\s*period|prepared(?:\s+(?:on|date))?|as\s+of\b/i;

function periodsIn(text: string): string[] {
  return [...text.matchAll(periodToken())].map((match) => match[0]);
}

function uniquePeriod(values: readonly string[]): string | null {
  if (!values.length) return null;
  const distinct = [...new Set(values.map((value) => value.toLowerCase()))];
  if (distinct.length === 1) return values[0]!;
  const withYear = values.filter((value) => /(?:19|20)\d{2}/.test(value) && !/^(?:19|20)\d{2}$/.test(value));
  const distinctYear = [...new Set(withYear.map((value) => value.toLowerCase()))];
  return distinctYear.length === 1 ? withYear[0]! : null;
}

function periodFromAnchorTexts(texts: readonly string[]): string | null {
  const found: string[] = [];
  for (const text of texts) {
    const periods = periodsIn(text);
    if (periods.length === 1) found.push(periods[0]!);
    else if (periods.length > 1) {
      const withYear = periods.filter((value) => /(?:19|20)\d{2}/.test(value) && !/^(?:19|20)\d{2}$/.test(value));
      if (withYear.length === 1) found.push(withYear[0]!);
    }
  }
  return uniquePeriod(found);
}

function periodTransition(instruction: string): { old: string; next: string } | null {
  const period = periodToken();
  const transitions = [...instruction.matchAll(/\b(?:into|to)\b|→|->/gi)].map((connector) => {
    const left = instruction.slice(Math.max(0, connector.index - 160), connector.index).split(/[.!?;\n]/).at(-1) ?? "";
    const right = (instruction.slice(connector.index + connector[0].length, connector.index + connector[0].length + 160).split(/[.!?;\n]/)[0] ?? "");
    const old = [...left.matchAll(period)].map((match) => match[0]);
    const next = [...right.matchAll(period)].map((match) => match[0]);
    if (old.length !== 1 || next.length !== 1 || old[0]!.toLowerCase() === next[0]!.toLowerCase()) return null;
    if (/^(?:19|20)\d{2}$/.test(old[0]!) && !/\b(?:update|refresh|revise|convert|change|turn)\b/i.test(left)) return null;
    return { old: old[0]!, next: next[0]! };
  }).filter((value): value is { old: string; next: string } => value !== null);
  return transitions.length === 1 ? transitions[0]! : null;
}

function periodTransitionFromAnchors(before: string | null, after: string | null): { old: string; next: string } | null {
  if (!before || !after || before.toLowerCase() === after.toLowerCase()) return null;
  return { old: before, next: after };
}

export function oldPeriodFromInstruction(instruction: string): string | null {
  return periodTransition(instruction)?.old ?? null;
}

function tableChangeMessage(before: readonly (readonly number[])[], after: readonly (readonly number[])[], operations: readonly string[]) {
  const count = (name: string) => operations.filter((operation) => operation === `document.${name}`).length;
  const expected: string[] = [];
  const unexpected: string[] = [];
  const tableDifference = after.length - before.length;
  if (tableDifference) {
    const supported = tableDifference > 0
      ? count("create_table") >= tableDifference && !count("delete_table")
      : count("delete_table") >= -tableDifference && !count("create_table");
    (supported ? expected : unexpected).push(supported
      ? `${Math.abs(tableDifference)} ${Math.abs(tableDifference) === 1 ? "table" : "tables"} ${tableDifference > 0 ? "created" : "deleted"} as expected`
      : `Table count changed unexpectedly: ${before.length} → ${after.length}`);
  } else {
    for (const [index, previous] of before.entries()) {
      const current = after[index]!;
      for (const [dimension, label, add, remove] of [
        [0, "row", "insert_table_rows", "delete_table_row"],
        [1, "column", "insert_table_column", "delete_table_column"],
      ] as const) {
        const difference = current[dimension]! - previous[dimension]!;
        if (!difference) continue;
        const changes = before.map((table, tableIndex) => after[tableIndex]![dimension]! - table[dimension]!);
        const totalAdded = changes.reduce((sum, change) => sum + Math.max(change, 0), 0);
        const totalRemoved = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0);
        const changedTables = changes.filter((change) => change > 0).length;
        const supported = difference > 0
          ? (count(add) + (label === "row" ? count("insert_table_row") : 0) >= totalAdded || (label === "row" && count("insert_table_rows") >= changedTables)) && !count(remove)
          : count(remove) >= totalRemoved && !count(add) && !(label === "row" && count("insert_table_row"));
        (supported ? expected : unexpected).push(supported
          ? `Table ${index + 1} ${label} count changed as expected: ${previous[dimension]} → ${current[dimension]}`
          : `Table ${index + 1} ${label} count changed unexpectedly: ${previous[dimension]} → ${current[dimension]}`);
      }
    }
  }
  return { expected, unexpected, tableDifference };
}

async function inspectAll(binding: DocxEngineBinding, bytes: Uint8Array, kind: "headings" | "tables") {
  const items: NonNullable<DocxInspectResult[typeof kind]>["items"][number][] = [];
  for (let offset = 0; ; offset += 100) {
    const result = await binding.inspectDocx(bytes, { focus: { kind, offset, limit: 100 } });
    if (!result.ok || !result[kind]) throw new Error(`Could not inspect ${kind}`);
    items.push(...result[kind].items as typeof items);
    if (!result[kind].page.hasMore) return items;
    if (!result[kind].page.returned) throw new Error(`Could not page ${kind}`);
  }
}

async function structure(binding: DocxEngineBinding, bytes: Uint8Array) {
  const overview = await binding.inspectDocx(bytes, { focus: { kind: "overview" } });
  if (!overview.ok || !overview.overview) throw new Error("Could not inspect DOCX overview");
  const [headings, tables, body] = await Promise.all([
    inspectAll(binding, bytes, "headings"),
    inspectAll(binding, bytes, "tables") as Promise<DocxInspectTableItem[]>,
    binding.inspectDocx(bytes, { focus: { kind: "body_blocks", offset: 0, limit: 100 } }).catch(() => null),
  ]);
  const anchorTexts: string[] = [];
  for (const heading of headings) {
    if ("text" in heading && heading.text?.trim()) anchorTexts.push(heading.text.trim());
  }
  if (body?.ok && body.bodyBlocks) {
    for (const block of body.bodyBlocks.items) {
      const text = block.text?.trim();
      if (text && periodAnchorLine.test(text)) anchorTexts.push(text);
    }
  }
  return {
    sections: overview.overview.sectionCount,
    bodyBlocks: overview.overview.bodyBlockCount,
    headings: headings.map((heading) => "level" in heading ? [heading.level, heading.styleName] : []),
    tables: tables.map((table) => [table.rowCount, table.columns.length]),
    tableItems: tables,
    periodAnchor: periodFromAnchorTexts(anchorTexts),
  };
}

function numberValue(text: string): number | null {
  const value = text.trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value.replace(/[$,]/g, ""));
  return Number.isSafeInteger(number) ? number : null;
}

async function reconcileTables(binding: DocxEngineBinding, bytes: Uint8Array, tables: Awaited<ReturnType<typeof structure>>["tableItems"]): Promise<DocumentCheck[]> {
  const checks: DocumentCheck[] = [];
  let tableNames: Map<string, string> | null = null;
  for (const [index, table] of tables.entries()) {
    // ponytail: tables over 100 rows are skipped; raise the cap if large reports need reconciliation.
    if (!table.isRectangular || table.rowCount > 100 || table.rowCount < 4 || table.columns.length < 2) continue;
    let detail: DocxInspectResult["tableRows"];
    const rows: (readonly string[])[] = [];
    for (let offset = 0; offset < table.rowCount; offset += 10) {
      const result = await binding.inspectDocx(bytes, { focus: { kind: "table_rows", tableHandle: table.handle, rowOffset: offset, rowLimit: 10 } }).catch(() => null);
      const page = result?.ok ? result.tableRows : undefined;
      if (!page || page.columnCount !== table.columns.length || page.rowCount !== table.rowCount ||
          page.rows.some((row, index) => row.index !== offset + index)) break;
      detail ??= page;
      rows.push(...page.rows.map((row) => row.cells));
    }
    if (!detail || rows.length !== table.rowCount) continue;
    const totals = rows.map((row, rowIndex) => /^total$/i.test(row[0]?.trim() ?? "") || /^grand total$/i.test(row[0]?.trim() ?? "") || /^network total$/i.test(row[0]?.trim() ?? "") ? rowIndex : -1).filter((rowIndex) => rowIndex >= 0);
    if (totals.length !== 1 || totals[0] !== rows.length - 1) continue;
    const totalIndex = totals[0]!;
    const data = rows.slice(0, totalIndex);
    const header = detail.headerTexts.length === table.columns.length &&
      detail.headerTexts.every((cell, column) => cell === data[0]?.[column]) ? data.shift() : undefined;
    if (data.length < 2 || data.some((row) => row.length !== table.columns.length)) continue;
    for (let column = 1; column < table.columns.length; column++) {
      const label = header?.[column] ?? detail.headerTexts[column] ?? table.columns[column]?.text ?? `Column ${column + 1}`;
      if (/percent|%|average|avg|ratio|rate|weighted|margin/i.test(label)) continue;
      const values = data.map((row) => numberValue(row[column] ?? ""));
      const total = numberValue(rows[totalIndex]?.[column] ?? "");
      if (total === null || values.some((value) => value === null)) continue;
      const sum = values.reduce<number>((value, item) => value + item!, 0);
      if (!Number.isSafeInteger(sum)) continue;
      if (sum !== total) {
        if (!tableNames) {
          tableNames = new Map();
          let heading = "";
          for (let offset = 0; ; offset += 100) {
            const result = await binding.inspectDocx(bytes, { focus: { kind: "body_blocks", offset, limit: 100 } }).catch(() => null);
            if (!result?.ok || !result.bodyBlocks) break;
            for (const block of result.bodyBlocks.items) {
              if (block.headingLevel && block.text?.trim()) heading = block.text.trim();
              if (block.tableHandle && heading) tableNames.set(block.tableHandle, heading);
            }
            if (!result.bodyBlocks.page.hasMore || !result.bodyBlocks.page.returned) break;
          }
        }
        checks.push({ id: `reconciliation-${index}-${column}`, status: "warning",
          message: `${tableNames.get(table.handle) ?? `Table ${index + 1}`} '${label}' rows sum to ${sum.toLocaleString("en-US")} but Total is ${total.toLocaleString("en-US")}.` });
      }
    }
  }
  return checks;
}

/** Fail when fields disappear without an intentional field mutation. */
async function verifyUnexpectedFieldLoss(
  binding: DocxEngineBinding,
  before: Uint8Array,
  after: Uint8Array,
  mutations: readonly string[],
  created: boolean,
): Promise<DocumentCheck[]> {
  if (created || !binding.inspectDocxFields) return [];
  if (mutations.some((name) => FIELD_MUTATION.test(name))) return [];
  const [beforeFields, afterFields] = await Promise.all([
    binding.inspectDocxFields(before).catch(() => null),
    binding.inspectDocxFields(after).catch(() => null),
  ]);
  if (!beforeFields?.ok || !afterFields?.ok) return [];
  if (beforeFields.total === 0) return [];
  if (afterFields.total >= beforeFields.total) return [];
  const beforeToc = beforeFields.fields.filter((field) => field.kind === "toc").length;
  const afterToc = afterFields.fields.filter((field) => field.kind === "toc").length;
  return [{
    id: "fields",
    status: "fail",
    message: beforeToc > afterToc
      ? `Unexpected TOC/field loss: ${beforeFields.total} → ${afterFields.total} inspectable fields`
      : `Unexpected field loss: ${beforeFields.total} → ${afterFields.total} inspectable fields`,
  }];
}

async function verifyCapabilityPostconditions(
  binding: DocxEngineBinding,
  after: Uint8Array,
  mutations: readonly string[],
): Promise<DocumentCheck[]> {
  const checks: DocumentCheck[] = [];
  const commentOps = mutations.filter((name) => COMMENT_MUTATION.test(name));
  const revisionOps = mutations.filter((name) => REVISION_MUTATION.test(name));
  const fieldOps = mutations.filter((name) => FIELD_MUTATION.test(name));
  if (!commentOps.length && !revisionOps.length && !fieldOps.length) return checks;

  if (commentOps.length) {
    if (!binding.inspectDocxComments) {
      checks.push({ id: "comments", status: "skipped", message: "Comment inspection unavailable" });
    } else {
      const inspection = await binding.inspectDocxComments(after).catch(() => null);
      if (!inspection?.ok) {
        checks.push({ id: "comments", status: "fail", message: "Comments could not be inspected after mutation" });
      } else {
        const broken = inspection.comments.filter((comment) => comment.structure === "orphaned" || comment.structure === "malformed");
        if (broken.length) {
          checks.push({
            id: "comments",
            status: "fail",
            message: `${broken.length} comment(s) have orphaned or malformed range structure`,
            evidence: broken[0]!.handle ?? broken[0]!.text.slice(0, 80),
          });
        } else if (commentOps.includes("document.add_comment") && inspection.total < 1) {
          checks.push({ id: "comments", status: "fail", message: "Comment add reported success but no comments are inspectable" });
        } else {
          checks.push({
            id: "comments",
            status: "pass",
            message: `Comments coherent (${inspection.total} inspectable)`,
          });
        }
      }
    }
  }

  if (revisionOps.length) {
    if (!binding.inspectDocxTrackedChanges) {
      checks.push({ id: "revisions", status: "skipped", message: "Revision inspection unavailable" });
    } else {
      const inspection = await binding.inspectDocxTrackedChanges(after).catch(() => null);
      if (!inspection?.ok) {
        checks.push({ id: "revisions", status: "fail", message: "Tracked changes could not be inspected after mutation" });
      } else {
        const broken = inspection.revisions.filter((revision) => revision.structure === "malformed");
        const authored = revisionOps.some((name) => /insert_tracked|delete_tracked|replace_text_with_tracked/.test(name));
        const decided = revisionOps.some((name) => /accept_revision|reject_revision/.test(name));
        if (broken.length) {
          checks.push({
            id: "revisions",
            status: "fail",
            message: `${broken.length} tracked change(s) are malformed`,
            evidence: broken[0]!.handle,
          });
        } else if (authored && !decided && inspection.insertionCount + inspection.deletionCount < 1) {
          checks.push({ id: "revisions", status: "fail", message: "Tracked-change authoring reported success but no insertion/deletion revisions are inspectable" });
        } else {
          checks.push({
            id: "revisions",
            status: "pass",
            message: decided
              ? `Revision decision applied (${inspection.insertionCount} insertions, ${inspection.deletionCount} deletions remain)`
              : `Tracked changes coherent (${inspection.insertionCount} insertions, ${inspection.deletionCount} deletions)`,
          });
        }
      }
    }
  }

  if (fieldOps.length) {
    if (!binding.inspectDocxFields) {
      checks.push({ id: "fields", status: "skipped", message: "Field inspection unavailable" });
    } else {
      const inspection = await binding.inspectDocxFields(after).catch(() => null);
      if (!inspection?.ok) {
        checks.push({ id: "fields", status: "fail", message: "Fields could not be inspected after mutation" });
      } else {
        const broken = inspection.fields.filter((field) => field.structure === "malformed");
        const tocFields = inspection.fields.filter((field) => field.kind === "toc");
        if (broken.length) {
          checks.push({
            id: "fields",
            status: "fail",
            message: `${broken.length} field(s) are malformed`,
            evidence: broken[0]!.instruction?.slice(0, 80) ?? broken[0]!.kind,
          });
        } else if (fieldOps.includes("document.insert_toc") && tocFields.length < 1) {
          checks.push({ id: "fields", status: "fail", message: "TOC insertion reported success but no TOC field is inspectable" });
        } else if (fieldOps.includes("document.insert_toc") && tocFields.some(tocNeedsRefresh)) {
          // Dirty/placeholder TOC is valid package state, not a finished populated TOC.
          checks.push({
            id: "fields",
            status: "warning",
            message: "TOC field inserted; refresh_required in Word/LibreOffice to populate entries and page numbers",
          });
        } else if (fieldOps.includes("document.insert_fields") && inspection.total < 1) {
          checks.push({ id: "fields", status: "fail", message: "Field insertion reported success but no fields are inspectable" });
        } else {
          checks.push({
            id: "fields",
            status: "pass",
            message: `Fields coherent (${inspection.total} inspectable)`,
          });
        }
      }
    }
  }

  return checks;
}

export async function verifyDocumentUpdate(input: {
  binding: DocxEngineBinding;
  before: Uint8Array;
  after: Uint8Array;
  instruction: string;
  targetAdvanced: boolean;
  sourcesUnchanged: boolean | null;
  successfulMutations?: readonly string[];
  unrecoveredFailedMutations?: readonly string[];
  created?: boolean;
  inputNeeded?: boolean;
}): Promise<DocumentCheck[]> {
  const mutations = input.successfulMutations ?? [];
  const unrecovered = input.unrecoveredFailedMutations ?? [];
  const checks: DocumentCheck[] = [
    { id: "target", status: input.targetAdvanced ? "pass" : "fail", message: input.targetAdvanced ? "Target updated" : "Target did not advance" },
    { id: "sources", status: input.sourcesUnchanged === null ? "skipped" : input.sourcesUnchanged ? "pass" : "fail", message: input.sourcesUnchanged === null ? "Source versions unavailable" : input.sourcesUnchanged ? "Source documents unchanged" : "A source document changed" },
  ];
  let after;
  try {
    after = await structure(input.binding, input.after);
    checks.push({ id: "open", status: "pass", message: "Saved DOCX can be inspected" });
  } catch {
    checks.push({ id: "open", status: "fail", message: "Saved DOCX could not be inspected" });
    if (unrecovered.length) {
      checks.push({
        id: "task",
        status: "fail",
        message: `Unresolved operations: ${unrecovered.join(", ")}`,
      });
    }
    return checks;
  }
  let beforePeriod: string | null = null;
  if (input.created) {
    const createdTables = mutations.filter((name) => name === "document.create_table").length;
    let hasContent = after.tables.length > 0 || after.headings.length > 0;
    let contentInspected = true;
    for (let offset = 0; !hasContent && offset < after.bodyBlocks; offset += 100) {
      const result = await input.binding.inspectDocx(input.after, { focus: { kind: "body_blocks", offset, limit: 100 } }).catch(() => null);
      if (!result?.ok || !result.bodyBlocks) { contentInspected = false; break; }
      hasContent = result.bodyBlocks.items.some((block) => Boolean(block.text?.trim()));
      if (!result.bodyBlocks.page.hasMore) break;
    }
    const valid = hasContent && after.tables.length >= createdTables;
    checks.push({ id: "structure", status: !contentInspected ? "skipped" : valid ? "pass" : "warning", message: !contentInspected ? "Created content could not be inspected" : !hasContent ? "Created document is empty" : !valid ? `Created ${after.tables.length} of ${createdTables} requested tables` : `Created document has content and ${after.tables.length} tables` });
  } else {
    try {
      const before = await structure(input.binding, input.before);
      beforePeriod = before.periodAnchor;
      const tables = tableChangeMessage(before.tables, after.tables, mutations);
      const expected = [...tables.expected];
      const unexpected = [...tables.unexpected];
      const sectionChange = mutations.some((name) => SECTION_MUTATION.test(name));
      if (before.sections !== after.sections) {
        (sectionChange ? expected : unexpected).push(sectionChange
          ? `Section count changed as expected: ${before.sections} → ${after.sections}`
          : `Section count changed: ${before.sections} → ${after.sections}`);
      }
      const paragraphChange = mutations.some((name) => /^document\.(?:insert_paragraphs?|delete_paragraph)$/.test(name));
      const headingChange = paragraphChange || mutations.includes("document.set_paragraph_style");
      if (JSON.stringify(before.headings) !== JSON.stringify(after.headings)) (headingChange ? expected : unexpected).push(headingChange ? "Heading structure changed as expected" : "Heading structure changed");
      // Section breaks introduce body blocks; treat those deltas as expected with section ops.
      if (before.bodyBlocks !== after.bodyBlocks && !paragraphChange && !sectionChange && !(tables.tableDifference && tables.expected.length && after.bodyBlocks - before.bodyBlocks === tables.tableDifference)) {
        unexpected.push(`Body block count changed: ${before.bodyBlocks} → ${after.bodyBlocks}`);
      } else if (before.bodyBlocks !== after.bodyBlocks && (paragraphChange || sectionChange)) {
        expected.push(`Body block count changed as expected: ${before.bodyBlocks} → ${after.bodyBlocks}`);
      }
      checks.push({ id: "structure", status: unexpected.length ? "warning" : "pass", message: [...expected, ...unexpected].join("; ") || "Structure preserved" });
    } catch {
      checks.push({ id: "structure", status: "skipped", message: "Original structure could not be inspected" });
    }
  }
  checks.push(...await reconcileTables(input.binding, input.after, after.tableItems));
  checks.push(...await verifyUnexpectedFieldLoss(input.binding, input.before, input.after, mutations, input.created === true));
  checks.push(...await verifyCapabilityPostconditions(input.binding, input.after, mutations));
  const transition = input.created
    ? null
    : periodTransition(input.instruction) ?? periodTransitionFromAnchors(beforePeriod, after.periodAnchor);
  if (!transition) checks.push({ id: "period", status: "skipped", message: "Period rollover not applicable to this edit" });
  else {
    const results = await Promise.all([transition.old, transition.next].map((text) => input.binding.findDocxText(input.after, { text })));
    const suspicious = results.every((result) => result.ok) ? results.flatMap((result) => result.matches).filter((match) => {
      const context = `${match.before}${match.text}${match.after}`;
      return /\b(?:scheduled|planned|upcoming|launching|due|expected|will|target date)\b/i.test(context) && !/\b(?:vs|versus|compared (?:with|to)|from|reported in|during|since|prior|previous)\b/i.test(context);
    }) : [];
    const first = suspicious[0];
    const excerpt = first ? `${first.before}${first.text}${first.after}`.trim().slice(0, 120) : "";
    checks.push(results.every((result) => result.ok)
      ? { id: "period", status: first ? "warning" : "pass", message: first ? `Possible stale period reference: '${excerpt}'` : "No suspicious stale-period statements found", ...(first ? { evidence: `${first.container}: ${excerpt}` } : {}) }
      : { id: "period", status: "skipped", message: "Report periods could not be searched" });
  }
  const found = [];
  for (const token of ["[", "TODO", "TBD"]) {
    const result = await input.binding.findDocxText(input.after, { text: token });
    if (!result.ok) { checks.push({ id: "placeholders", status: "skipped", message: "Placeholders could not be searched" }); break; }
    for (const match of result.matches) {
      const context = `${match.before}${match.text}${match.after}`;
      // Search excerpts can end before a long input instruction closes its bracket.
      if (token.startsWith("[") ? /^\[\s*(?:(?:UPDATE|INSERT|Add|Enter|Provide|Your)\b|(?:Email(?: address)?|Phone(?: number)?|City,?\s*State|LinkedIn(?: URL)?|Degree|Graduation year)\s*\])/i.test(context.slice(match.before.length)) : new RegExp(`\\b${token}\\b`).test(context.slice(Math.max(0, match.before.length - 1)))) {
        found.push(`${match.container}: ${context}`.slice(0, 160));
      }
    }
  }
  if (!checks.some((check) => check.id === "placeholders")) {
    checks.push({ id: "placeholders", status: found.length ? "warning" : "pass", message: found.length ? input.inputNeeded ? `${found.length} unresolved values require user input` : `${found.length} unresolved placeholder(s)` : "No unresolved placeholders", ...(found[0] ? { evidence: found[0] } : {}) });
  }

  const refreshRequired = checks.some((check) => check.id === "fields" && check.status === "warning" && /refresh_required/i.test(check.message));
  if (unrecovered.length) {
    checks.push({
      id: "task",
      status: "fail",
      message: mutations.length
        ? `Partial update: unresolved operations: ${unrecovered.join(", ")}`
        : `Could not complete requested update: ${unrecovered.join(", ")}`,
    });
  } else if (refreshRequired) {
    checks.push({
      id: "task",
      status: "warning",
      message: "Update requires external field refresh (refresh_required)",
    });
  } else if (mutations.length) {
    checks.push({ id: "task", status: "pass", message: "Requested mutations completed" });
  }
  return checks;
}
