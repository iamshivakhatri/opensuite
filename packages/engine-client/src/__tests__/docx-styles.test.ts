import assert from "node:assert/strict";
import test from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("custom style bridge advances verified bytes and keeps failure atomic", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("create_style")) return t.skip("local Pass 2 engine required");
  const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  assert.equal((await doc.mutate("create_style", { styleId: "ClientHeading", styleType: "paragraph", name: "Client Heading", basedOn: "Heading1", color: "124733" })).ok, true);
  assert.equal((await doc.mutate("insert_paragraph", { text: "Bridge heading", placement: { kind: "end" } })).ok, true);
  assert.equal((await doc.mutate("set_paragraph_style", { target: { text: "Bridge heading" }, style: "Client Heading" })).ok, true);
  const updated = await binding.executeDocxUpdateStyle!(doc.currentBytes(), { styleId: "ClientHeading", styleType: "paragraph", color: "235744", next: "Normal" });
  assert.equal(updated.result.ok, true);
  const snapshot = await binding.inspectDocxStyleSnapshot(updated.output!);
  const style = snapshot.styles.find(s => s.styleId === "ClientHeading")!;
  assert.equal(style.paragraphUsageCount, 1);
  assert.equal(style.nextStyleId, "Normal");
  assert.equal(style.effectiveRunFormatting?.color, "235744");
  const before = Buffer.from(doc.currentBytes());
  assert.equal((await doc.mutate("update_style", { styleId: "Heading1", styleType: "paragraph", basedOn: "ClientHeading" })).ok, false);
  assert.deepEqual(Buffer.from(doc.currentBytes()), before);
});
