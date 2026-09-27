import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocxEngineBinding } from "@opensuite/engine-client";
import { oldPeriodFromInstruction, verifyDocumentUpdate } from "./document-verification.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const binding = {
  async inspectDocx(data: Uint8Array, request: { focus: { kind: string } }) {
    const content = new TextDecoder().decode(data);
    const changed = content.includes("STRUCTURE_CHANGED");
    const rowsAdded = content.includes("ROWS_ADDED");
    const tableLost = content.includes("TABLE_LOST");
    if (request.focus.kind === "overview") return { ok: true, overview: { sectionCount: 1, bodyBlockCount: changed ? 3 : tableLost ? 1 : 2, paragraphCount: 2, tableCount: tableLost ? 0 : 1 } };
    const items = request.focus.kind === "headings"
      ? [{ occurrence: 0, text: "Report", styleName: "Heading 1", level: 1 }]
      : tableLost ? [] : [{ occurrence: 0, handle: "t0", rowCount: rowsAdded ? 4 : changed ? 3 : 2, columns: [{ occurrence: 0, handle: "c0", text: "A" }], rows: [] }];
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

async function check(after: string, instruction = "Update August report into September report", options: { targetAdvanced?: boolean; sourcesUnchanged?: boolean; successfulMutations?: string[] } = {}) {
  return verifyDocumentUpdate({ binding, before: bytes("August report"), after: bytes(after), instruction,
    targetAdvanced: options.targetAdvanced ?? true, sourcesUnchanged: options.sourcesUnchanged ?? true, successfulMutations: options.successfulMutations });
}

test("saved target advances while sources stay unchanged; a clean refresh preserves structure", async () => {
  const checks = await check("September report");
  assert.deepEqual(checks.map((item) => [item.id, item.status]), [
    ["target", "pass"], ["sources", "pass"], ["open", "pass"], ["structure", "pass"], ["period", "pass"], ["placeholders", "pass"],
  ]);
});

test("old period and unresolved placeholders carry evidence", async () => {
  const checks = await check("September report. August backlog. [UPDATE figures] TODO");
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
  assert.equal((await check("September report", "Refresh this report")).find((item) => item.id === "period")?.status, "skipped");
});

test("explicit report transitions accept words between periods and Q/year updates", () => {
  assert.equal(oldPeriodFromInstruction("Update the August Northstar launch report into the September 2026 report"), "August");
  assert.equal(oldPeriodFromInstruction("Update August 2026 report into September 2026 report"), "August 2026");
  assert.equal(oldPeriodFromInstruction("Update the Q2 report to Q3"), "Q2");
  assert.equal(oldPeriodFromInstruction("Update the 2025 report to 2026"), "2025");
  assert.equal(oldPeriodFromInstruction("Compare the 2025 report to 2026"), null);
});

test("successful row insertion explains its matching structural difference", async () => {
  const checks = await check("September ROWS_ADDED", undefined, { successfulMutations: ["document.insert_table_rows"] });
  assert.equal(checks.find((item) => item.id === "structure")?.status, "pass");
  assert.match(checks.find((item) => item.id === "structure")?.message ?? "", /2 table rows added as expected/);
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
