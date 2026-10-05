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

test("paragraph controls round-trip and clear to inherited formatting", { skip: !process.env.OPENSUITE_ENGINE_PATH }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  async function edit(capability: string, operation: Record<string, unknown>) {
    const result = await doc.mutate(capability, operation);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  await edit("insert_paragraph", { text: "Formatting check", placement: { kind: "end" } });
  await edit("update_style", { styleId: "Normal", styleType: "paragraph", lineSpacing: { value: 240, rule: "auto" }, keepLines: false, italic: true, fontFamily: "Arial", fontSizeHalfPoints: 22 });
  const patch = { alignment: "both", spacingBeforeTwips: 120, spacingAfterTwips: 240,
    lineSpacing: { value: 276, rule: "auto" }, leftIndentTwips: 720, rightIndentTwips: 360,
    firstLineIndentTwips: 240, keepWithNext: true, keepLines: true };
  await edit("set_paragraph_formatting", { target: { text: "Formatting check" }, ...patch });
  let snapshot = await binding.inspectDocxStyleSnapshot(doc.currentBytes());
  const paragraph = () => snapshot.paragraphPatterns.find(p => p.locations.includes("body"))!;
  for (const [field, value] of Object.entries(patch)) assert.deepEqual(paragraph().directFormatting[field as keyof typeof patch], value, field);
  await edit("set_paragraph_formatting", { target: { text: "Formatting check" }, hangingIndentTwips: 360, clear: ["firstLineIndentTwips", "lineSpacing", "keepLines"] });
  snapshot = await binding.inspectDocxStyleSnapshot(doc.currentBytes());
  assert.equal(paragraph().directFormatting.firstLineIndentTwips, undefined);
  assert.equal(paragraph().directFormatting.hangingIndentTwips, 360);
  assert.equal(paragraph().directFormatting.lineSpacing, undefined);
  assert.equal(paragraph().directFormatting.keepLines, undefined);
  assert.deepEqual(paragraph().effectiveFormatting?.lineSpacing, { value: 240, rule: "auto" });
  assert.equal(paragraph().effectiveFormatting?.keepLines, false);
  await edit("set_text_formatting", { target: { text: "Formatting check" }, italic: false, fontFamily: "Courier New", fontSizeHalfPoints: 30 });
  await edit("set_text_formatting", { target: { text: "Formatting check" }, clear: ["italic", "fontFamily", "fontSizeHalfPoints"] });
  snapshot = await binding.inspectDocxStyleSnapshot(doc.currentBytes());
  const run = snapshot.typography.runPatterns[0]!;
  assert.equal(run.directFormatting.italic, undefined);
  assert.equal(run.directFormatting.fontFamily, undefined);
  assert.equal(run.directFormatting.fontSizeHalfPoints, undefined);
  assert.equal(run.effectiveFormatting?.italic, true);
  assert.equal(run.effectiveFormatting?.fontFamily, "Arial");
  assert.equal(run.effectiveFormatting?.fontSizeHalfPoints, 22);
  const before = Buffer.from(doc.currentBytes());
  assert.equal((await doc.mutate("set_text_formatting", { target: { text: "Formatting check" }, fontSizeHalfPoints: 65558 })).ok, false);
  assert.deepEqual(Buffer.from(doc.currentBytes()), before);
  for (const invalid of [{ alignment: "invalid" }, { lineSpacing: { value: 240, rule: "invalid" } }, { clear: ["invalid"] }]) {
    assert.equal((await doc.mutate("set_paragraph_formatting", { target: { text: "Formatting check" }, ...invalid })).ok, false);
    assert.deepEqual(Buffer.from(doc.currentBytes()), before);
  }
});
