import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("note bridge distinguishes kinds, rejects stale handles, and preserves body text", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_note")) return t.skip("local notes engine required");
  const inserted = await binding.executeDocxInsertParagraph(binding.createBlankDocx(), { text: "Revenue improved. Margin increased.", placement: { kind: "end" } });
  const doc = bindDocxDocument({ binding, bytes: inserted.output! });
  for (const [kind, text] of [["footnote", "Revenue improved."], ["endnote", "Margin increased."]]) {
    assert.equal((await doc.mutate("insert_note", { kind, target: { text }, text: `${kind} detail` })).ok, true);
  }
  const first = (await doc.inspect({ focus: { kind: "notes" } })).notes!;
  assert.equal(first.footnoteCount, 1); assert.equal(first.endnoteCount, 1);
  const old = first.notes[0]!.handle!;
  assert.equal((await doc.mutate("update_note", { handle: old, text: "Updated basis." })).ok, true);
  assert.equal((await doc.mutate("delete_note", { handle: old })).ok, false);
  const after = await binding.inspectDocxNotes!(doc.currentBytes());
  assert.equal(after.notes[1]!.text, "endnote detail");
  assert.equal((await doc.mutate("delete_note", { handle: after.notes[0]!.handle })).ok, true);
  assert.equal((await binding.inspectDocxNotes!(doc.currentBytes())).footnoteCount, 0);
  assert.equal((await doc.find({ text: "Revenue improved. Margin increased." })).matches.length, 1);
  assert.equal((await doc.mutate("insert_note", { kind: "citation", target: { text: "Revenue" }, text: "No" })).ok, false);
});
