import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocxEngineBinding } from "@opensuite/engine-client";
import { oldPeriodFromInstruction, verifyDocumentUpdate } from "./document-verification.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const months = "January|February|March|April|May|June|July|August|September|October|November|December";
const binding = {
  async inspectDocx(data: Uint8Array, request: { focus: { kind: string; rowOffset?: number; rowLimit?: number } }) {
    const content = new TextDecoder().decode(data);
    const changed = content.includes("STRUCTURE_CHANGED");
    const rowsAdded = content.includes("ROWS_ADDED");
    const rowAdded = content.includes("ROW_ADDED");
    const tableLost = content.includes("TABLE_LOST");
    const created = content.includes("CREATED");
    const title = content.split(/\n/).find((line) => line.trim())?.trim() || (created ? "New Report" : "Report");
    if (request.focus.kind === "overview") return { ok: true, overview: { sectionCount: 1, bodyBlockCount: created ? 28 : changed ? 3 : tableLost ? 1 : 2, paragraphCount: 2, tableCount: created ? 3 : tableLost ? 0 : 1 } };
    if (request.focus.kind === "body_blocks") {
      const items: { handle: string; kind: string; text?: string; headingLevel?: number; tableHandle?: string }[] = [];
      for (const line of content.split(/\n/)) {
        const text = line.trim();
        if (!text) continue;
        if (/reporting\s*period|prepared(?:\s+(?:on|date))?|as\s+of\b/i.test(text)) {
          items.push({ handle: `b${items.length}`, kind: "paragraph", text });
        }
      }
      if (content.includes("PIPELINE")) {
        items.push({ handle: `b${items.length}`, kind: "paragraph", text: "Sales Pipeline", headingLevel: 2 });
        items.push({ handle: `b${items.length}`, kind: "table", tableHandle: "t0" });
      }
      return { ok: true, bodyBlocks: { page: { total: items.length, offset: 0, returned: items.length, hasMore: false }, items } };
    }
    if (request.focus.kind === "table_rows") {
      const cells = content.includes("PIPELINE") ? [["Stage", "Value (USD)"], ["Discovery", "620,000"], ["Evaluation", "540,000"], ["Proposal", "480,000"], ["Negotiation", "260,000"], ["Total", content.includes("BAD_TOTAL") || content.includes("2350000") ? "2,350,000" : "1,900,000"]]
        : content.includes("WEIGHTED") ? [["Stage", "Weighted %"], ["A", "40%"], ["B", "60%"], ["Total", "50%"]] : [];
      if ((request.focus.rowLimit ?? 3) > 10) return { ok: false, diagnostics: [{ code: "INVALID_TABLE_ROW_LIMIT" }] };
      const offset = request.focus.rowOffset ?? 0;
      return { ok: true, tableRows: { tableHandle: "t0", rowCount: cells.length, columnCount: 2, headerTexts: cells[0] ?? [], rowOffset: offset, rows: cells.slice(offset, offset + (request.focus.rowLimit ?? 3)).map((row, index) => ({ index: offset + index, cells: row })) } };
    }
    const items = request.focus.kind === "headings"
      ? [{ occurrence: 0, text: created ? "New Report" : title, styleName: "Heading 1", level: 1 }]
      : tableLost ? [] : Array.from({ length: created ? 3 : 1 }, (_, index) => {
          const headerMatch = content.match(new RegExp(`\\b(?:${months})(?:\\s+(?:19|20)\\d{2})?\\b`, "i"));
          const periodHeader = content.includes("PERIOD_COL") && headerMatch ? headerMatch[0] : "A";
          return {
            occurrence: index,
            handle: `t${index}`,
            rowCount: content.includes("PIPELINE") ? 6 : content.includes("WEIGHTED") ? 4 : rowsAdded ? 4 : rowAdded ? 3 : changed ? 3 : 2,
            isRectangular: true,
            columns: content.includes("PIPELINE") || content.includes("WEIGHTED")
              ? [{ occurrence: 0, handle: "c0", text: "Stage" }, { occurrence: 1, handle: "c1", text: content.includes("WEIGHTED") ? "Weighted %" : "Value (USD)" }]
              : [{ occurrence: 0, handle: "c0", text: periodHeader }],
            rows: [],
          };
        });
    return { ok: true, [request.focus.kind]: { page: { total: items.length, offset: 0, returned: items.length, hasMore: false }, items } };
  },
  async findDocxText(data: Uint8Array, request: { text: string }) {
    const content = new TextDecoder().decode(data);
    const matches = [...content.matchAll(new RegExp(request.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))].map((match, occurrence) => ({
      occurrence, text: match[0], before: content.slice(Math.max(0, match.index - 20), match.index),
      after: content.slice(match.index + match[0].length, match.index + match[0].length + 30), container: "body",
    }));
    return { ok: true, query: request.text, matchCount: matches.length, matches, diagnostics: [] };
  },
} as unknown as DocxEngineBinding;

async function check(
  after: string,
  instruction = "Update August report into September report",
  options: {
    before?: string;
    targetAdvanced?: boolean;
    sourcesUnchanged?: boolean;
    successfulMutations?: string[];
    created?: boolean;
    inputNeeded?: boolean;
  } = {},
) {
  return verifyDocumentUpdate({
    binding,
    before: bytes(options.before ?? "August report"),
    after: bytes(after),
    instruction,
    targetAdvanced: options.targetAdvanced ?? true,
    sourcesUnchanged: options.sourcesUnchanged ?? true,
    successfulMutations: options.successfulMutations,
    created: options.created,
    inputNeeded: options.inputNeeded,
  });
}

test("saved target advances while sources stay unchanged; a clean refresh preserves structure", async () => {
  const checks = await check("September report");
  assert.deepEqual(checks.map((item) => [item.id, item.status]), [
    ["target", "pass"], ["sources", "pass"], ["open", "pass"], ["structure", "pass"], ["period", "pass"], ["placeholders", "pass"],
  ]);
  assert.equal(checks.find((item) => item.id === "period")?.message, "No suspicious stale-period statements found");
});

test("suspicious old-period statements and unresolved placeholders carry evidence", async () => {
  const checks = await check("September report. Formal audit is scheduled for August. [UPDATE figures] TODO");
  assert.equal(checks.find((item) => item.id === "period")?.status, "warning");
  assert.match(checks.find((item) => item.id === "period")?.evidence ?? "", /August/);
  assert.equal(checks.find((item) => item.id === "placeholders")?.status, "warning");
  assert.match(checks.find((item) => item.id === "placeholders")?.evidence ?? "", /UPDATE/);
});

test("structural differences warn, while a source advance fails", async () => {
  const checks = await check("September STRUCTURE_CHANGED", undefined, { sourcesUnchanged: false });
  assert.equal(checks.find((item) => item.id === "structure")?.status, "warning");
  assert.equal(checks.find((item) => item.id === "sources")?.status, "fail");
});

test("ambiguous and absent periods skip without guessing", async () => {
  assert.equal(oldPeriodFromInstruction("Update August report into September report; July report into August report"), null);
  assert.equal(oldPeriodFromInstruction("Refresh this report"), null);
  assert.equal((await check("Same report", "Refresh this report", { before: "Same report" })).find((item) => item.id === "period")?.status, "skipped");
});

test("explicit report transitions accept words between periods and Q/year updates", () => {
  assert.equal(oldPeriodFromInstruction("Update the August Northstar launch report into the September 2026 report"), "August");
  assert.equal(oldPeriodFromInstruction("Update August 2026 report into September 2026 report"), "August 2026");
  assert.equal(oldPeriodFromInstruction("Update the Q2 report to Q3"), "Q2");
  assert.equal(oldPeriodFromInstruction("Update the 2025 report to 2026"), "2025");
  assert.equal(oldPeriodFromInstruction("Compare the 2025 report to 2026"), null);
});

test("April to May title rollover is applicable even without instruction transition phrasing", async () => {
  const checks = await check(
    "May 2027 Monthly Report\nReporting Period: May 2027",
    "Refresh this report with the attached May sources",
    { before: "April 2027 Monthly Report\nReporting Period: April 2027" },
  );
  assert.equal(checks.find((item) => item.id === "period")?.status, "pass");
  assert.equal(checks.find((item) => item.id === "period")?.message, "No suspicious stale-period statements found");
});

test("rollover keeps legitimate historical old-period references quiet", async () => {
  const checks = await check(
    "May 2027 Monthly Report\nReporting Period: May 2027\nReleased in April 2027. Revenue increased from April. Change vs April.",
    "Update April 2027 report into May 2027 report",
    { before: "April 2027 Monthly Report\nReporting Period: April 2027" },
  );
  assert.equal(checks.find((item) => item.id === "period")?.status, "pass");
  assert.equal(checks.find((item) => item.id === "period")?.message, "No suspicious stale-period statements found");
});

test("ordinary non-period edits stay not applicable", async () => {
  const checks = await check("enrolment 270", "change enrolment 260 to 270", { before: "enrolment 260" });
  assert.equal(checks.find((item) => item.id === "period")?.status, "skipped");
  assert.equal(checks.find((item) => item.id === "period")?.message, "Period rollover not applicable to this edit");
});

test("stale current-period future wording after rollover is reported", async () => {
  const checks = await check(
    "May 2027 Monthly Report\nReporting Period: May 2027\nLaunch is scheduled for April.",
    "Update April report into May report",
    { before: "April 2027 Monthly Report\nReporting Period: April 2027" },
  );
  assert.equal(checks.find((item) => item.id === "period")?.status, "warning");
  assert.match(checks.find((item) => item.id === "period")?.message ?? "", /scheduled for April/);
});

test("successful row insertion explains its matching structural difference", async () => {
  const checks = await check("September ROWS_ADDED", undefined, { successfulMutations: ["document.insert_table_rows"] });
  assert.equal(checks.find((item) => item.id === "structure")?.status, "pass");
  assert.match(checks.find((item) => item.id === "structure")?.message ?? "", /row count changed as expected: 2 → 4/);
});

test("additive totals reconcile or warn independently of saving", async () => {
  const mismatch = await check("September PIPELINE BAD_TOTAL");
  assert.equal(mismatch.find((item) => item.id === "reconciliation-0-1")?.message, "Sales Pipeline 'Value (USD)' rows sum to 1,900,000 but Total is 2,350,000.");
  assert.equal(mismatch.find((item) => item.id === "reconciliation-0-1")?.status, "warning");
  assert.equal((await check("September PIPELINE")).some((item) => item.id.startsWith("reconciliation")), false);
  assert.equal((await check("September WEIGHTED")).some((item) => item.id.startsWith("reconciliation")), false);
});

test("generic replace_text of only the Total still reconciles the final table", async () => {
  const before = "September PIPELINE Total=1900000";
  const after = before.replace("1900000", "2350000");
  assert.equal((await check(before, "Change only the Total", { before, successfulMutations: ["document.set_table_cells_text"] })).some((item) => item.id.startsWith("reconciliation")), false);
  const checks = await check(after, "Change only the Total", { before, successfulMutations: ["document.replace_text"] });
  assert.equal(checks.find((item) => item.id === "reconciliation-0-1")?.message, "Sales Pipeline 'Value (USD)' rows sum to 1,900,000 but Total is 2,350,000.");
  assert.equal(checks.find((item) => item.id === "reconciliation-0-1")?.status, "warning");
  assert.equal(checks.find((item) => item.id === "period")?.status, "skipped");
  assert.equal((await check(after, "Change only the Total", { before, successfulMutations: ["document.set_table_cells_text"] })).find((item) => item.id === "reconciliation-0-1")?.status, "warning");
});

test("one intentional row insert passes; unexplained row insert warns", async () => {
  assert.equal((await check("September ROW_ADDED", undefined, { successfulMutations: ["document.insert_table_row"] })).find((item) => item.id === "structure")?.status, "pass");
  assert.match((await check("September ROW_ADDED")).find((item) => item.id === "structure")?.message ?? "", /row count changed unexpectedly/);
});

test("creation and bounded edits skip period rollover noise", async () => {
  const created = await check("CREATED September report", undefined, { created: true, successfulMutations: ["document.create_table"] });
  assert.equal(created.find((item) => item.id === "structure")?.status, "pass");
  assert.equal(created.find((item) => item.id === "period")?.status, "skipped");
  assert.doesNotMatch(JSON.stringify(created), /Heading structure changed|Body block count changed|No unambiguous/);
  assert.equal((await check("enrolment 270", "change enrolment 260 to 270", { before: "enrolment 260" })).find((item) => item.id === "period")?.status, "skipped");
});

test("historical comparisons stay quiet and input-needed placeholders are explicit", async () => {
  const checks = await check("September report: revenue increased from August. Change vs August. TBD TBD", undefined, { inputNeeded: true });
  assert.equal(checks.find((item) => item.id === "period")?.status, "pass");
  assert.equal(checks.find((item) => item.id === "placeholders")?.message, "2 unresolved values require user input");
});

test("a future-sounding statement about the completed report month gets review", async () => {
  const checks = await check("September report. The formal audit is scheduled for September.");
  assert.equal(checks.find((item) => item.id === "period")?.status, "warning");
  assert.match(checks.find((item) => item.id === "period")?.message ?? "", /scheduled for September/);
});

test("one single-row insertion cannot explain two added rows", async () => {
  const checks = await check("September ROWS_ADDED", undefined, { successfulMutations: ["document.insert_table_row"] });
  assert.equal(checks.find((item) => item.id === "structure")?.status, "warning");
});

test("table loss without a matching delete remains a warning", async () => {
  const checks = await check("September TABLE_LOST", undefined, { successfulMutations: ["document.insert_table_rows"] });
  assert.equal(checks.find((item) => item.id === "structure")?.status, "warning");
  assert.match(checks.find((item) => item.id === "structure")?.message ?? "", /Table count changed unexpectedly: 1 → 0/);
});
