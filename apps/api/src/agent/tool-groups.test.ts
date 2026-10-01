import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinishTool, defineTool, providerSafeToolName, type AgentEvent } from "@opensuite/agent-core-v3";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";
import { jsonSchema } from "ai";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createDocumentTools } from "./document-tools.js";
import { buildAgentOperatingInstruction } from "./operating-instruction.js";
import { createToolSurface } from "./tool-groups.js";

async function createSurface() {
  const session = await createPrimaryDocxTools({
    binding: await createNapiDocxEngineBinding(), documents: {} as never,
    ownerUserId: "user", workspaceId: "workspace", documentId: null, versionId: null,
  });
  const finish = createFinishTool();
  return createToolSurface({ ...session!.tools, [finish.name]: finish.tool,
    finish_with_input_needed: defineTool({ kind: "read", terminal: true, description: "input needed",
      inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => "" }),
    request_clarification: defineTool({ kind: "read", terminal: true, description: "clarification",
      inputSchema: jsonSchema({ type: "object", properties: { question: { type: "string" } }, required: ["question"] }), execute: ({ question }: { question: string }) => question }),
  });
}

const call = { toolCallId: "load", messages: [], context: undefined as never };
const load = (surface: Awaited<ReturnType<typeof createSurface>>, groups: string[]) =>
  surface.tools["tools.load_group"]!.execute!({ groups }, call);

test("common surface is sorted, covers the report update and preserves workspace/finish tools", async () => {
  const surface = await createSurface();
  const names = Object.keys(surface.initialTools);
  assert.equal(names.length, 17);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(Object.keys(surface.projectTools()), names);
  for (const name of ["document.batch_replace_text", "document.inspect", "document.delete_table_row",
    "document.set_table_cells_text", "document.replace_text", "finish", "finish_with_input_needed", "request_clarification",
    "document.find", "document.insert_paragraphs", "document.set_paragraph_style", "document.create_table",
    "workspace.create_blank_document", "workspace.duplicate_current_document", "workspace.select_document", "workspace.inspect_document"]) {
    assert.ok(surface.initialTools[name], name);
    assert.equal(surface.initialTools[name], surface.tools[name]);
  }
  assert.equal(surface.initialTools["document.set_table_cells_formatting"], undefined);
});

test("loading is monotonic, idempotent, run-local and rejects unknown groups without partial activation", async () => {
  const surface = await createSurface();
  assert.deepEqual(await load(surface, ["table_styling"]), { ok: true, activeGroups: ["table_styling"] });
  const names = Object.keys(surface.projectTools());
  assert.ok(surface.projectTools()["document.set_table_cells_formatting"]);
  assert.deepEqual(await load(surface, ["table_styling", "table_styling"]), { ok: true, activeGroups: ["table_styling"] });
  assert.deepEqual(Object.keys(surface.projectTools()), names);
  assert.deepEqual(await load(surface, ["text_formatting", "unknown"]), { ok: false, reasonCode: "UNKNOWN_TOOL_GROUP" });
  assert.deepEqual(await load(surface, ["toString"]), { ok: false, reasonCode: "UNKNOWN_TOOL_GROUP" });
  assert.deepEqual(await load(surface, []), { ok: false, reasonCode: "UNKNOWN_TOOL_GROUP" });
  assert.deepEqual(Object.keys(surface.projectTools()), names);
  await load(surface, ["text_formatting"]);
  assert.ok(names.every((name) => surface.projectTools()[name]));
  assert.equal((await createSurface()).initialTools["document.set_table_cells_formatting"], undefined);
});

test("all current tools have exactly one group or common placement; group/tool order ignores loading order", async () => {
  const first = await createSurface();
  const second = await createSurface();
  const groups = first.capabilityIndex.split("\n").map((line) => line.split(":")[0]!);
  assert.deepEqual(groups, ["page_layout", "paragraphs", "rich_content", "table_structure", "table_styling", "text_formatting"]);
  const expectedCounts = [5, 6, 4, 5, 4, 2];
  const grouped = new Set(Object.keys(first.initialTools));
  for (const [index, group] of groups.entries()) {
    const single = await createSurface();
    await load(single, [group]);
    assert.ok(single.projectTools().request_clarification);
    const added = Object.keys(single.projectTools()).filter((name) => !single.initialTools[name]);
    assert.equal(added.length, expectedCounts[index]);
    for (const name of added) { assert.equal(grouped.has(name), false, name); grouped.add(name); }
  }
  assert.deepEqual([...grouped].sort(), Object.keys(first.tools).sort());
  assert.equal(grouped.size, 43); // 41 existing tools plus discovery and clarification.
  await load(first, groups);
  for (const group of [...groups].reverse()) await load(second, [group]);
  assert.deepEqual(Object.keys(first.projectTools()), Object.keys(second.projectTools()));
  assert.deepEqual(first.summary().groupsLoaded, second.summary().groupsLoaded);
});

test("group index and loader honor existing engine/host capability filtering", async () => {
  const tools = createDocumentTools({ capabilities: () => ({ formats: [{ format: "docx", capabilities: ["inspect", "set_text_formatting"] }] }),
    inspect: async () => ({}), find: async () => ({}), mutate: async () => ({ ok: true }),
  });
  const surface = createToolSurface(tools);
  assert.match(surface.capabilityIndex, /^text_formatting:/);
  assert.equal(surface.capabilityIndex.split("\n").length, 1);
  assert.deepEqual(await surface.tools["tools.load_group"]!.execute!({ groups: ["table_styling"] }, call), { ok: false, reasonCode: "UNKNOWN_TOOL_GROUP" });
  await surface.tools["tools.load_group"]!.execute!({ groups: ["text_formatting"] }, call);
  assert.deepEqual(Object.keys(surface.projectTools()), ["document.inspect", "document.set_text_formatting", "tools.load_group"]);
  assert.equal(createToolSurface({}).tools["tools.load_group"], undefined);
});

test("prompt advertises only the initial names and a compact group index", async () => {
  const surface = await createSurface();
  const system = buildAgentOperatingInstruction(Object.keys(surface.initialTools).map(providerSafeToolName), surface.capabilityIndex);
  const inventory = system.split("INITIAL TOOLS\n")[1]!.split("OPERATING PRINCIPLES")[0]!;
  assert.match(inventory, /- tools_load_group/);
  assert.match(inventory, /- request_clarification/);
  assert.match(inventory, /table_styling: Change table/);
  assert.doesNotMatch(inventory, /document_set_table_cells_formatting|inputSchema|properties/);
  assert.match(system, /load its tool group before concluding it is unsupported/);
});

test("tool surface logs record turn snapshots, discovery attempts and run totals", async () => {
  const surface = await createSurface();
  const lines: string[] = [];
  const info = console.info;
  console.info = (line) => { lines.push(String(line)); };
  const completed = (turn: number, count: number, toolNames: string[]) => ({
    type: "model_turn_completed", turn, durationMs: 1, inputTokens: 1, cachedInputTokens: 0,
    outputTokens: 1, reasoningTokens: 0, finishReason: "tool-calls", toolNames,
    exposedToolCount: count, exposedToolSchemaChars: 100,
  }) as Extract<AgentEvent, { type: "model_turn_completed" }>;
  try {
    surface.projectTools();
    surface.recordTurn(completed(1, 17, ["tools.load_group"]), "test");
    await load(surface, ["table_styling"]);
    surface.projectTools();
    surface.recordTurn(completed(2, 21, ["document.set_table_formatting"]), "test");
    assert.deepEqual(surface.summary(), { initialToolCount: 17, peakToolCount: 21, groupsLoaded: ["table_styling"], discoveryTurnCount: 1 });
    assert.match(lines[0]!, /exposedToolCount=17 exposedToolSchemaChars=100 activeGroups=none discoveryTurn=true/);
    assert.match(lines[1]!, /activeGroups=table_styling discoveryTurn=false/);
  } finally { console.info = info; }
});
