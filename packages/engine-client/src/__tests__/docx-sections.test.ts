import assert from "node:assert/strict";
import test from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("local section APIs advance bound bytes, inspect, and reject stale handles", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("inspect_sections")) return t.skip("local E1 engine required");
  const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  for (const breakType of ["nextPage", "continuous"]) {
    assert.equal((await doc.mutate("insert_section_break", { placement: { kind: "end" }, breakType })).ok, true);
  }
  const before = await doc.inspect({ focus: { kind: "sections" } });
  assert.equal(before.sections?.length, 3);
  const handle = before.sections![1]!.handle;
  const changed = await binding.executeDocxSetSectionProperties!(doc.currentBytes(), { handle, pageSetup: { orientation: "landscape" } });
  assert.equal(changed.result.ok, true);
  assert.equal((await doc.mutate("set_section_properties", { handle, differentFirstPage: true, pageNumberStart: 1 })).ok, true);
  assert.equal((await doc.mutate("set_section_header_footer", { handle, kind: "header", variant: "first", action: "text", text: "Stale" })).ok, false);
  const current = await doc.inspect({ focus: { kind: "sections" } });
  assert.equal((await doc.mutate("set_section_header_footer", { handle: current.sections![1]!.handle, kind: "header", variant: "first", action: "text", text: "Cover" })).ok, true);
  const after = await doc.inspect({ focus: { kind: "sections" } });
  assert.equal(after.sections![1]!.headersFooters[1]!.text, "Cover");
  assert.equal(after.sections![1]!.pageNumberStart, 1);
  assert.equal(after.sections![0]!.differentFirstPage, false);
});
