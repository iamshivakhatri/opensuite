import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentOperatingInstruction, buildDocumentUpdateInstruction } from "./operating-instruction.js";

test("update policy preserves source-silent facts and flags missing input", () => {
  const policy = buildDocumentUpdateInstruction();
  assert.match(policy, /source is silent, carry forward existing metrics, table rows/);
  assert.match(policy, /Change only facts the new evidence supports/);
  assert.match(policy, /never invent numbers, dates, status, owners, deadlines, events, or a breakdown from a total/);
  assert.match(policy, /finish_with_input_needed/);
  assert.doesNotMatch(buildAgentOperatingInstruction(["finish"]), /DOCUMENT UPDATE RULE/);
});

test("operating instruction embeds general policy and only exposed tools", () => {
  const system = buildAgentOperatingInstruction([
    "document.find",
    "document.inspect",
    "document.replace_text",
    "finish",
  ]);

  assert.match(system, /You are OpenSuite's document agent/);
  assert.match(system, /AVAILABLE CAPABILITIES/);
  assert.match(system, /OPERATING PRINCIPLES/);
  assert.match(system, /- document\.find/);
  assert.match(system, /- document\.inspect/);
  assert.match(system, /- document\.replace_text/);
  assert.match(system, /- finish/);
  assert.match(system, /Use the finish operation when the requested work is complete/);
  assert.equal(system.includes("document.capabilities"), false);
  assert.equal(system.includes("insert_picture"), false);
  assert.equal(system.includes("replace_picture"), false);
  // No request-specific or find→mutate workflow prescriptions.
  assert.equal(system.includes("change X to Y"), false);
  assert.equal(/Always call/i.test(system), false);
  assert.equal(system.includes("Prefer document.find"), false);
});

test("hidden picture ops are not advertised when absent from the toolset", () => {
  const system = buildAgentOperatingInstruction([
    "document.find",
    "document.set_paragraph_style",
    "finish",
  ]);
  assert.equal(system.includes("document.insert_picture"), false);
  assert.equal(system.includes("document.replace_picture"), false);
  assert.equal(system.includes("- document.set_paragraph_style"), true);
  assert.equal(system.includes("- document.find"), true);
  assert.equal(system.includes("- document.inspect"), false);
});

test("empty toolset lists none under AVAILABLE CAPABILITIES", () => {
  const system = buildAgentOperatingInstruction([]);
  assert.match(system, /AVAILABLE CAPABILITIES\n- \(none\)/);
});

test("silent recovery: recoverable failures must not be narrated to users", () => {
  const system = buildAgentOperatingInstruction(["document.replace_text", "finish"]);
  assert.match(system, /recover silently/i);
  assert.match(system, /Do not narrate reason codes/i);
  assert.match(system, /stale handles/i);
  assert.match(
    system,
    /Only mention an unresolved limitation in the final response if it materially prevents/i,
  );
});

test("optional cosmetic polish: abandon after repeated failure; keep required work", () => {
  const system = buildAgentOperatingInstruction([
    "document.set_table_cell_shading",
    "document.create_table",
    "finish",
  ]);
  assert.match(system, /optional cosmetic polish/i);
  assert.match(system, /fails more than once/i);
  assert.match(system, /skip it and finish/i);
  assert.match(
    system,
    /For an explicit user requirement or document correctness, make a reasonable recovery attempt/i,
  );
  // Must not tell the model to abandon required content or explicit asks.
  assert.equal(/immediately abandon/i.test(system), false);
  assert.equal(/always skip shading/i.test(system), false);
});

test("table guidance delays handle inspection and groups stable table edits", () => {
  const system = buildAgentOperatingInstruction(["document.inspect", "document.set_table_cell_shading"]);
  assert.match(system, /Finish content, paragraph, and structural edits before inspecting for exact table\/cell handles/);
  assert.match(system, /inspect the table once, do related table formatting together/);
  assert.match(system, /use stable text selectors when unambiguous/);
  assert.match(system, /Do not reuse old handles after another mutation/);
  assert.match(system, /shade all header cells in one call before other mutations/);
  assert.match(system, /Row\/column text selectors do not target header cells/);
  assert.match(system, /Paragraph style\/formatting tools do not format table-cell text; set_text_formatting does for simple cells/);
  assert.match(system, /TABLE_COLUMN_NOT_FOUND mean the selector missed the target/);
  assert.match(system, /state the unmet requirement in the final response/);
});

test("recovered failure guidance does not require narrating internal errors", () => {
  const system = buildAgentOperatingInstruction([
    "document.set_paragraph_style",
    "finish",
  ]);
  assert.match(system, /Recover by changing strategy/i);
  assert.match(system, /keep low-level diagnostics out of user-facing text/i);
  assert.equal(system.includes("always explain tool failures"), false);
});
