import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentOperatingInstruction, buildDocumentUpdateInstruction } from "./operating-instruction.js";
import { createDocumentTools } from "./document-tools.js";

test("clarification requires material ambiguity and excludes cheap recovery and delegated choices", () => {
  const system = buildAgentOperatingInstruction(["request_clarification", "finish"]);
  assert.match(system, /request_clarification alone, before further edits, only when a requested outcome requires choosing between two or more materially different unsupported interpretations/);
  assert.match(system, /Ask one concise, actionable question; keep internal tool details out of it/);
  assert.match(system, /Do not ask for capitalization, punctuation, obvious spelling mistakes, singular\/plural differences, obvious abbreviations, a unique high-confidence semantic match, cosmetic uncertainty/);
  assert.match(system, /choices the user delegated.*use your judgment.*choose reasonable values/);
  assert.match(system, /merely because unrelated or source-silent content must remain unchanged/);
  assert.match(system, /Do not choose an unsupported interpretation merely to avoid asking/);
  assert.match(system, /Missing handles or selectors call for a cheap document.inspect/);
  assert.match(system, /normal tool failures with a deterministic recovery path call for recovery/);
  assert.match(buildDocumentUpdateInstruction(), /finish normally/);
});

test("update policy preserves source-silent facts and flags missing input", () => {
  const policy = buildDocumentUpdateInstruction();
  assert.match(policy, /Current document state is authoritative/);
  assert.match(policy, /Change only content the user's request or supplied\/source evidence supports/);
  assert.match(policy, /Never invent unsupported facts, values, dates, statuses, owners, events/);
  assert.match(policy, /Correct preservation is success for that part/);
  assert.match(policy, /Replacing an anchor fact does not transfer dependent claims/);
  assert.match(policy, /independently supported for the new anchor/);
  assert.match(policy, /Preserve genuinely independent neighboring facts/);
  assert.match(policy, /Do not back-solve missing values from rounded or incomplete displayed figures/);
  assert.match(policy, /Recalculate derived values only when every required operand is exact/);
  assert.match(policy, /Related facts are not the same fact/);
  assert.match(policy, /clearly expresses the same fact\/value/);
  assert.match(policy, /remains factually valid as historical or prior state/);
  assert.match(policy, /finish_with_input_needed/);
  assert.match(policy, /If preservation is the correct result, finish normally/);
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
  assert.match(system, /Use finish when the requested work is complete/);
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

test("tool selection favors semantic targets, direct mutation, and deferred handle details", () => {
  const system = buildAgentOperatingInstruction(["document.inspect", "document.set_table_cell_shading"]);
  assert.match(system, /Prefer semantic document\/table selectors over global text replacement/);
  assert.match(system, /Use replace_text or batch_replace_text only when the target is genuinely text-level/);
  assert.match(system, /mutate directly\. Do not inspect or search merely to rediscover content already available/);
  assert.match(system, /Inspect only when an exact required target cannot already be expressed/);
  assert.match(system, /Prefer exact semantic selectors from current context when unambiguous/);
  assert.match(system, /Inspect for handles only when a required operation needs them/);
  assert.match(system, /Use tool descriptions as the source of truth for handle lifetime/);
  assert.match(system, /one batch or multi-target operation when it covers several known independent edits/);
  assert.match(system, /Do not repeatedly reconsider a valid mutation plan/);
  assert.match(system, /TABLE_COLUMN_NOT_FOUND mean the selector missed the target/);
  assert.match(system, /state the unmet requirement in the final response/);
  assert.match(system, /Correct preservation is success, not missing information/);
});

test("table tool descriptions favor exact selectors and one call per logical edit", () => {
  const capabilities = ["set_table_cells_text", "set_table_cells_formatting", "set_table_cell_shading", "set_text_formatting", "insert_table_rows", "insert_table_row", "delete_table_row"];
  const tools = createDocumentTools({
    capabilities: () => ({ formats: [{ format: "docx", capabilities }] }),
    inspect: async () => ({}), find: async () => ({}), mutate: async () => ({}), mutateBatch: async () => ({}),
  });
  assert.match(String(tools["document.set_table_cells_text"]?.description), /Update known cells in one table/);
  assert.match(String(tools["document.set_table_cells_text"]?.description), /original table state/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /table \+ row \+ column/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /all relevant cells in one call/);
  assert.match(String(tools["document.set_table_cells_formatting"]?.description), /fill and direct text formatting together/);
  assert.match(String(tools["document.set_table_cell_shading"]?.description), /table \+ row \+ column/);
  assert.match(String(tools["document.set_table_cell_shading"]?.description), /set_table_cells_formatting for fill and text together/);
  const cellTargetSchema = (name: string) => (tools[`document.${name}`]?.inputSchema as {
    jsonSchema: { properties: { updates: { items: { properties: { target: unknown } } } } };
  }).jsonSchema.properties.updates.items.properties.target;
  assert.deepEqual(cellTargetSchema("set_table_cells_formatting"), cellTargetSchema("set_table_cells_text"));
  assert.deepEqual(cellTargetSchema("set_table_cell_shading"), cellTargetSchema("set_table_cells_text"));
  const deleteRow = (tools["document.delete_table_row"]?.inputSchema as {
    jsonSchema: { properties: { row: { properties: Record<string, unknown> } } };
  }).jsonSchema.properties.row;
  const cellRow = (cellTargetSchema("set_table_cells_text") as { properties: { row: { properties: Record<string, unknown> } } }).properties.row;
  for (const key of ["kind", "text", "occurrence", "index", "expectedFirstCellText"]) {
    assert.deepEqual(deleteRow.properties[key], cellRow.properties[key]);
  }
  assert.ok(deleteRow.properties.handle);
  assert.ok(deleteRow.properties.firstCellText);
  assert.match(String(tools["document.delete_table_row"]?.description), /Prefer row/);
  assert.match(String(tools["document.set_text_formatting"]?.description), /known whole table cells, use set_table_cells_formatting/);
  assert.match(String(tools["document.batch_text_formatting"]?.description), /set_table_cells_formatting for known whole cells/);
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
