import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("typed fields and TOC bridge round-trip with bounded inspection", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_toc")) return t.skip("insert_toc capability required");
  const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  assert.equal((await doc.mutate("insert_fields", { location: "footer", content: [{ kind: "text", text: "Page " }, { kind: "page" }, { kind: "text", text: " of " }, { kind: "numPages" }] })).ok, true);
  assert.equal((await doc.mutate("insert_toc", { placement: { kind: "start" }, title: "Table of Contents" })).ok, true);
  const first = (await doc.inspect({ focus: { kind: "fields", limit: 1 } })).fields!;
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.equal(first.fields[0]!.kind, "toc");
  assert.deepEqual(first.fields[0]!.headingLevels, [1, 3]);
  assert.equal(first.fields[0]!.dirty, true);
  const rest = await binding.inspectDocxFields!(doc.currentBytes(), { offset: 1, limit: 1000 });
  assert.deepEqual(rest.fields.map(f => [f.kind, f.cachedResult, f.dirty]), [["page", "?", true], ["numPages", "?", true]]);
});
