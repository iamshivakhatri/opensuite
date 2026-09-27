import type { DocxEngineBinding, DocxInspectResult } from "@opensuite/engine-client";

export interface DocumentCheck {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail" | "skipped";
  readonly message: string;
  readonly evidence?: string;
}

const months = "January February March April May June July August September October November December".split(" ");

export function oldPeriodFromInstruction(instruction: string): string | null {
  const period = new RegExp(`\\b(?:${months.join("|")}|Q[1-4])(?:\\s+(?:19|20)\\d{2})?\\b|\\b(?:19|20)\\d{2}\\b`, "gi");
  const transitions = [...instruction.matchAll(/\b(?:into|to)\b|→|->/gi)].map((connector) => {
    const left = instruction.slice(Math.max(0, connector.index - 160), connector.index).split(/[.!?;\n]/).at(-1) ?? "";
    const right = (instruction.slice(connector.index + connector[0].length, connector.index + connector[0].length + 160).split(/[.!?;\n]/)[0] ?? "");
    const old = [...left.matchAll(period)].map((match) => match[0]);
    const next = [...right.matchAll(period)].map((match) => match[0]);
    if (old.length !== 1 || next.length !== 1 || old[0]!.toLowerCase() === next[0]!.toLowerCase()) return null;
    if (/^(?:19|20)\d{2}$/.test(old[0]!) && !/\b(?:update|refresh|revise|convert|change|turn)\b/i.test(left)) return null;
    return old[0]!;
  }).filter((value): value is string => value !== null);
  return transitions.length === 1 ? transitions[0]! : null;
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
          ? (count(add) >= totalAdded || (label === "row" && count("insert_table_rows") >= changedTables)) && !count(remove)
          : count(remove) >= totalRemoved && !count(add) && !(label === "row" && count("insert_table_row"));
        (supported ? expected : unexpected).push(supported
          ? `${Math.abs(difference)} table ${label}${Math.abs(difference) === 1 ? "" : "s"} ${difference > 0 ? "added" : "removed"} as expected`
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
  const [headings, tables] = await Promise.all([
    inspectAll(binding, bytes, "headings"),
    inspectAll(binding, bytes, "tables"),
  ]);
  return {
    sections: overview.overview.sectionCount,
    bodyBlocks: overview.overview.bodyBlockCount,
    headings: headings.map((heading) => "level" in heading ? [heading.level, heading.styleName] : []),
    tables: tables.map((table) => "rowCount" in table ? [table.rowCount, table.columns.length] : []),
  };
}

export async function verifyDocumentUpdate(input: {
  binding: DocxEngineBinding;
  before: Uint8Array;
  after: Uint8Array;
  instruction: string;
  targetAdvanced: boolean;
  sourcesUnchanged: boolean | null;
  successfulMutations?: readonly string[];
}): Promise<DocumentCheck[]> {
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
    return checks;
  }
  try {
    const before = await structure(input.binding, input.before);
    const tables = tableChangeMessage(before.tables, after.tables, input.successfulMutations ?? []);
    const unexpected = [...tables.unexpected];
    if (before.sections !== after.sections) unexpected.push(`Section count changed: ${before.sections} → ${after.sections}`);
    if (JSON.stringify(before.headings) !== JSON.stringify(after.headings)) unexpected.push("Heading structure changed");
    if (before.bodyBlocks !== after.bodyBlocks && !(tables.tableDifference && tables.expected.length && after.bodyBlocks - before.bodyBlocks === tables.tableDifference)) {
      unexpected.push(`Body block count changed: ${before.bodyBlocks} → ${after.bodyBlocks}`);
    }
    checks.push({ id: "structure", status: unexpected.length ? "warning" : "pass", message: [...tables.expected, ...unexpected].join("; ") || "Structure preserved" });
  } catch {
    checks.push({ id: "structure", status: "skipped", message: "Original structure could not be inspected" });
  }
  const oldPeriod = oldPeriodFromInstruction(input.instruction);
  if (!oldPeriod) checks.push({ id: "period", status: "skipped", message: "No unambiguous old and new period" });
  else {
    const result = await input.binding.findDocxText(input.after, { text: oldPeriod });
    checks.push(result.ok
      ? { id: "period", status: result.matchCount ? "warning" : "pass", message: result.matchCount ? `${oldPeriod} remains ${result.matchCount} time(s)` : `No ${oldPeriod} references remain`, ...(result.matches[0] ? { evidence: `${result.matches[0].container}: ${result.matches[0].before}${result.matches[0].text}${result.matches[0].after}`.slice(0, 160) } : {}) }
      : { id: "period", status: "skipped", message: "Old period could not be searched" });
  }
  const found = [];
  for (const token of ["[UPDATE", "[INSERT", "TODO", "TBD"]) {
    const result = await input.binding.findDocxText(input.after, { text: token });
    if (!result.ok) { checks.push({ id: "placeholders", status: "skipped", message: "Placeholders could not be searched" }); return checks; }
    for (const match of result.matches) {
      const context = `${match.before}${match.text}${match.after}`;
      if (token.startsWith("[") ? /^\[(?:UPDATE|INSERT)\b[^\]]*\]/i.test(context.slice(match.before.length)) : new RegExp(`\\b${token}\\b`).test(context.slice(Math.max(0, match.before.length - 1)))) {
        found.push(`${match.container}: ${context}`.slice(0, 160));
      }
    }
  }
  checks.push({ id: "placeholders", status: found.length ? "warning" : "pass", message: found.length ? `${found.length} unresolved placeholder(s)` : "No unresolved placeholders", ...(found[0] ? { evidence: found[0] } : {}) });
  return checks;
}
