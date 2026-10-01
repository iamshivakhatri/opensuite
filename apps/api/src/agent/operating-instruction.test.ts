import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentOperatingInstruction, buildDocumentUpdateInstruction } from "./operating-instruction.js";
import { createDocumentTools } from "./document-tools.js";

test("clarification requires material ambiguity and excludes cheap recovery and delegated choices", () => {
  const system = buildAgentOperatingInstruction(["request_clarification", "finish"]);
  assert.match(system, /only when BOTH \(1\).*materially conflicts.*required information is genuinely missing, AND \(2\) two or more plausible interpretations/);
  assert.match(system, /meaningfully different document facts, structure, or requested outcomes/);
  assert.match(system, /one narrow read.*do not repeat reads to avoid asking/);
  assert.match(system, /call request_clarification alone.*before further edits/);
  assert.match(system, /Stop speculative reasoning; do not choose an unsupported interpretation merely to avoid asking/);
  assert.match(system, /Keep internal tool details out of the question/);
  assert.match(system, /Do not request clarification for capitalization, punctuation, obvious spelling mistakes, singular\/plural differences, obvious abbreviations, a unique high-confidence semantic match, cosmetic uncertainty/);
  assert.match(system, /choices the user delegated.*use your judgment.*choose reasonable values/);
  assert.match(system, /Missing handles or selectors call for a cheap document.inspect/);
  assert.match(system, /normal tool failures with a deterministic recovery path call for recovery/);
  assert.match(buildDocumentUpdateInstruction(), /If the clarification rule above does not apply/);
});

test("update policy preserves source-silent facts and flags missing input", () => {
  const policy = buildDocumentUpdateInstruction();
  assert.match(policy, /source is silent, carry forward existing metrics, table rows/);
  assert.match(policy, /Change only facts the new evidence supports/);
  assert.match(policy, /never invent numbers, dates, status, owners, deadlines, events, or a breakdown from a total/);
  assert.match(policy, /finish_with_input_needed/);
  assert.doesNotMatch(buildAgentOperatingInstruction(["finish"]), /DOCUMENT UPDATE RULE/);
});

test("operating instruction starts useful tools without a narrated full plan", () => {
  const system = buildAgentOperatingInstruction(["document.replace_text", "finish"]);
  assert.match(system, /use a tool as soon as you can act safely/);
  assert.match(system, /make only the read needed for the next action/);
  assert.match(system, /Do not spend a model turn narrating or completing a full plan before the first useful tool call/);
  assert.doesNotMatch(system, /plan a coherent set of edits/);
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
  assert.match(system, /prefer exact semantic selectors when unambiguous/);
  assert.match(system, /Inspected handles can be reused within one model turn/);
  assert.match(system, /Other successful edits invalidate handles immediately/);
  assert.match(system, /inspect again before using handles in a later turn/);
  assert.match(system, /set_table_cells_formatting to set fill and bold\/color in one call/);
  assert.match(system, /one batch or multi-target operation when it covers several known edits/);
  assert.match(system, /exact table headerCells\/occurrence from retrieval when available/);
  assert.match(system, /inspect only for needed row\/cell handles, missing structure, or fresh handles after a structural change/);
  assert.match(system, /Row\/column text selectors do not target header cells/);
  assert.match(system, /Paragraph style\/formatting tools do not format table-cell text/);
  assert.match(system, /TABLE_COLUMN_NOT_FOUND mean the selector missed the target/);
  assert.match(system, /state the unmet requirement in the final response/);
});

test("table tool descriptions favor exact selectors and one call per logical edit", () => {
  const capabilities = ["set_table_cells_text", "set_table_cells_formatting", "set_table_cell_shading", "insert_table_rows", "insert_table_row"];
  const tools = createDocumentTools({
    capabilities: () => ({ formats: [{ format: "docx", capabilities }] }),
    inspect: async () => ({}), find: async () => ({}), mutate: async () => ({}),
  });
  assert.match(String(tools["document.set_table_cells_text"]?.description), /all known cells in one table with one call/);
  assert.match(String(tools["document.set_table_cells_text"]?.description), /exact headerCells\/occurrence from retrieval/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /current cell handles from one inspect\(tables\)/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /all relevant cells in one call/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /fill and direct text formatting together/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /handles expire before the next model turn or after other edits/);
  assert.match(String(tools["document.set_table_cell_shading"]?.description), /use set_table_cells_formatting for fill and text together/);
  assert.match(String(tools["document.insert_table_rows"]?.description), /prefer this over repeated insert_table_row calls/);
  assert.match(String(tools["document.insert_table_row"]?.description), /use insert_table_rows when several contiguous rows are known/);
});

test("paragraph insertion tools explain blank document placement and inspected handles", () => {
  const tools = createDocumentTools({
    capabilities: () => ({ formats: [{ format: "docx", capabilities: ["insert_paragraph", "insert_paragraphs"] }] }),
    inspect: async () => ({}),
    find: async () => ({}),
    mutate: async () => ({}),
  });
  for (const name of ["document.insert_paragraph", "document.insert_paragraphs"]) {
    const tool = tools[name]!;
    assert.match(String(tool.description), /blank document.*kind: "end".*kind: "start".*without a handle/);
    const schema = (tool.inputSchema as { jsonSchema: { properties: { placement: { description: string; properties: { handle: { description: string } } } } } }).jsonSchema;
    assert.match(schema.properties.placement.description, /blank document \(which has no handles\)/);
    assert.match(schema.properties.placement.description, /latest relevant document\.inspect; never invent one/);
    assert.match(schema.properties.placement.description, /expire before the next model turn or after other edits/);
    assert.match(schema.properties.placement.properties.handle.description, /Omit for start\/end\. Required for before\/after/);
  }
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
