import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocxEngineBinding } from "@opensuite/engine-client";
import { oldPeriodFromInstruction, verifyDocumentUpdate } from "./document-verification.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const binding = {
  async inspectDocx(data: Uint8Array, request: { focus: { kind: string } }) {
    const changed = new TextDecoder().decode(data).includes("STRUCTURE_CHANGED");
    if (request.focus.kind === "overview") return { ok: true, overview: { sectionCount: 1, bodyBlockCount: changed ? 3 : 2, paragraphCount: 2, tableCount: 1 } };
    const items = request.focus.kind === "headings"
      ? [{ occurrence: 0, text: "Report", styleName: "Heading 1", level: 1 }]
      : [{ occurrence: 0, handle: "t0", rowCount: changed ? 3 : 2, columns: [{ occurrence: 0, handle: "c0", text: "A" }], rows: [] }];
    return { ok: true, [request.focus.kind]: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items } };
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

async function check(after: string, instruction = "Update August report into September report", options: { targetAdvanced?: boolean; sourcesUnchanged?: boolean } = {}) {
  return verifyDocumentUpdate({ binding, before: bytes("August report"), after: bytes(after), instruction,
    targetAdvanced: options.targetAdvanced ?? true, sourcesUnchanged: options.sourcesUnchanged ?? true });
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
