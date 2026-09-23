import assert from "node:assert/strict";
import { test } from "node:test";

import { buildThreadTitlePrompt, normalizeThreadTitle } from "./thread-title.js";

test("thread title prompt uses the request and compact document maps only", () => {
  const prompt = buildThreadTitlePrompt({
    instruction: "Compare the kickoff memo with the Monday guide.",
    workingSet: [{ documentId: "memo", versionId: "v1", name: "Kickoff Memo.docx", format: "docx" }],
    documentMaps: [{
      artifact: { documentId: "memo", versionId: "v1", name: "Kickoff Memo.docx", format: "docx" },
      entries: [{ kind: "heading", level: 1, text: "Schedule" }],
    }],
  });

  assert.match(prompt, /Compare the kickoff memo/);
  assert.match(prompt, /Kickoff Memo\.docx/);
  assert.match(prompt, /Schedule/);
  assert.doesNotMatch(prompt, /tool schema|conversation history/i);
});

test("thread title normalization accepts one short non-empty line", () => {
  assert.equal(normalizeThreadTitle('  "Kickoff Memo Comparison"  '), "Kickoff Memo Comparison");
  assert.equal(normalizeThreadTitle("\n"), null);
  assert.equal(normalizeThreadTitle("A title that is deliberately much longer than the sixty character limit allows"), null);
});
