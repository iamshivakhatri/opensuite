import type { DocxEngineBinding, DocxInspectResult } from "@opensuite/engine-client";

export interface DocumentCheck {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail" | "skipped";
  readonly message: string;
  readonly evidence?: string;
}

const months = "January February March April May June July August September October November December".split(" ");

export function oldPeriodFromInstruction(instruction: string): string | null {
  const period = `(?:${months.join("|")}|(?:19|20)\\d{2})`;
  const matches = [...instruction.matchAll(new RegExp(`\\b(${period})\\s+(?:report\\s+)?(?:into|to)\\s+(?:the\\s+)?(${period})\\b`, "gi"))];
  if (matches.length !== 1 || matches[0]![1]!.toLowerCase() === matches[0]![2]!.toLowerCase()) return null;
  return matches[0]![1]!;
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
    const differences = (Object.keys(after) as (keyof typeof after)[])
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    checks.push({ id: "structure", status: differences.length ? "warning" : "pass", message: differences.length ? `Structure changed: ${differences.join(", ")}` : "Structure preserved" });
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
