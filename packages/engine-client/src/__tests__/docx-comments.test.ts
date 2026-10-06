import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("comment bridge supplies UTC metadata and rejects stale handles", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("add_comment")) return t.skip("local comments engine required");
  const inserted = await binding.executeDocxInsertParagraph(binding.createBlankDocx(), { text: "Revenue increased 12% in Q3.", placement: { kind: "end" } });
  const doc = bindDocxDocument({ binding, bytes: inserted.output! });
  assert.equal((await doc.mutate("add_comment", { target: { text: "12%" }, text: "Check finance.", author: "Reviewer" })).ok, true);
  const first = await binding.inspectDocxComments!(doc.currentBytes());
  assert.equal(first.comments[0]!.anchoredText, "12%");
  assert.ok(Number.isFinite(Date.parse(first.comments[0]!.date!)));
  const old = first.comments[0]!.handle!;
  assert.equal((await doc.mutate("update_comment", { handle: old, text: "Confirmed." })).ok, true);
  assert.equal((await doc.mutate("delete_comment", { handle: old })).ok, false);
  const inspection = await doc.inspect({ focus: { kind: "comments", limit: 1 } });
  assert.equal(inspection.comments!.comments[0]!.author, "Reviewer");
  assert.equal((await doc.mutate("delete_comment", { handle: inspection.comments!.comments[0]!.handle! })).ok, true);
  assert.equal((await binding.inspectDocxComments!(doc.currentBytes())).total, 0);
  assert.equal((await binding.findDocxText(doc.currentBytes(), { text: "Revenue increased 12% in Q3." })).matches.length, 1);
});
