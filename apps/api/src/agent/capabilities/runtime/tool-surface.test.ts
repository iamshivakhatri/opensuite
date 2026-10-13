import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinishTool, defineTool, providerSafeToolName, runAgent } from "@opensuite/agent-core";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";
import { jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createPrimaryDocxTools } from "../../docx-tools.js";
import { createDocumentTools } from "../../document-tools.js";
import { buildAgentOperatingInstruction } from "../../operating-instruction.js";
import { createToolSurface } from "./tool-surface.js";
import { projectLoadedInstructions } from "./instruction-projection.js";
import type { CapabilityEvent } from "../core/session.js";

async function createSurface(emit?: (event: CapabilityEvent) => void) {
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
    "workspace.search_documents": defineTool({ kind: "read", description: "search",
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }), execute: () => ({ matches: [] }) }),
  }, emit);
}

const call = { toolCallId: "load", messages: [], context: undefined as never };
const load = (surface: Awaited<ReturnType<typeof createSurface>>, ids: string[]) =>
  surface.tools["capabilities.load"]!.execute!({ ids }, call);

test("root surface stays compact and common document workflows remain available", async () => {
  const surface = await createSurface();
  assert.equal(Object.keys(surface.initialTools).length, 21);
  assert.deepEqual(Object.keys(surface.initialTools), Object.keys(surface.initialTools).sort());
  for (const name of ["document.inspect", "document.replace_text", "document.set_table_cells_text",
    "workspace.select_document", "workspace.search_documents", "finish", "request_clarification",
    "capabilities.list", "capabilities.search", "capabilities.load"]) assert.ok(surface.initialTools[name], name);
  assert.equal(surface.initialTools["document.set_table_cells_formatting"], undefined);
  assert.deepEqual(surface.session.roots().map((item) => item.id), ["agent", "document", "skills", "styles", "workspace"]);
  assert.equal(surface.capabilityIndex.includes("table_styling"), false);
  const system = buildAgentOperatingInstruction(Object.keys(surface.initialTools).map(providerSafeToolName), surface.capabilityIndex);
  assert.match(system, /capabilities_list/);
  assert.doesNotMatch(system, /document_set_table_cells_formatting|inputSchema/);
});

test("list returns immediate available children and search returns compact results", async () => {
  const surface = await createSurface();
  const list = surface.tools["capabilities.list"]!.execute!;
  assert.deepEqual((await list!({ parentId: "document.tables" }, call) as { capabilities: { id: string }[] }).capabilities.map((item) => item.id),
    ["document.tables.structure", "document.tables.styling"]);
  assert.deepEqual((await list!({ parentId: "document" }, call) as { capabilities: { id: string }[] }).capabilities.some((item) => item.id === "document.tables.styling"), false);
  const search = await surface.tools["capabilities.search"]!.execute!({ query: "shading" }, call) as { capabilities: unknown[] };
  assert.ok(search.capabilities.length > 0 && search.capabilities.length <= 8);
  assert.equal(JSON.stringify(search).includes("inputSchema"), false);
});

test("loading is monotonic, idempotent, run-local, and rejects unavailable IDs atomically", async () => {
  const surface = await createSurface();
  assert.deepEqual(await load(surface, ["document.tables.styling"]), { ok: true, loadedIds: ["document.tables.styling"] });
  assert.ok(surface.projectTools()["document.set_table_cells_formatting"]);
  assert.equal(surface.session.search("document.tables.styling").capabilities[0]?.loaded, true);
  assert.deepEqual(await load(surface, ["document.tables.styling"]), { ok: true, loadedIds: ["document.tables.styling"] });
  assert.deepEqual(await load(surface, ["document.text", "unknown"]), { ok: false, reasonCode: "CAPABILITY_UNAVAILABLE", invalidIds: ["unknown"], alternatives: [], message: "Use loadable IDs from capabilities.search or capabilities.list." });
  const invalid = await load(surface, ["document"]) as { ok: boolean; reasonCode: string; alternatives: string[] };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reasonCode, "CAPABILITY_NOT_LOADABLE");
  assert.ok(invalid.alternatives.length > 0);
  for (const id of invalid.alternatives) assert.equal(surface.session.search(id).capabilities[0]?.loadable, true);
  assert.equal(surface.projectTools()["document.set_text_formatting"], undefined);
  assert.equal((await createSurface()).initialTools["document.set_table_cells_formatting"], undefined);
});

test("engine filtering removes unsupported tools and their empty groups", async () => {
  const tools = createDocumentTools({ capabilities: () => ({ formats: [{ format: "docx", capabilities: ["inspect", "set_text_formatting"] }] }),
    inspect: async () => ({}), find: async () => ({}), mutate: async () => ({ ok: true }),
  });
  const surface = createToolSurface(tools);
  assert.deepEqual(surface.session.roots().map((item) => item.id), ["agent", "document", "skills", "styles"]);
  assert.deepEqual(surface.session.list("document.tables"), { ok: false, reasonCode: "CAPABILITY_UNAVAILABLE" });
  const unavailable = surface.session.load(["document.tables.styling"]);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.reasonCode, "CAPABILITY_UNAVAILABLE");
  surface.session.load(["document.text"]);
  assert.ok(surface.projectTools()["document.set_text_formatting"]);
  assert.equal(surface.projectTools()["document.set_table_formatting"], undefined);
});

test("advertised loadable IDs load exactly, report active tools, and never expand on repeats", async () => {
  const surface = await createSurface();
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    const result = surface.session.list(parentId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const item of result.capabilities) {
      if (item.loadable) {
        seen.add(item.id);
        assert.equal(surface.session.load([item.id]).ok, true, item.id);
      }
      if (item.kind === "group") visit(item.id);
    }
  };
  visit(null);
  assert.ok(seen.size > 30);
  const tools = Object.keys(surface.projectTools());
  for (const id of seen) assert.equal(surface.session.load([id]).ok, true);
  assert.deepEqual(Object.keys(surface.projectTools()), tools);
  const results = surface.session.search("style");
  assert.deepEqual(surface.session.search("style"), results);
  assert.equal(results.capabilities.find(item => item.id === "styles")?.loadable, false);
  assert.equal(results.capabilities.find(item => item.id === "document.update_style")?.loaded, true);
  assert.equal(JSON.stringify(results).includes('"title"'), false);
});

test("narrow tool loads mark group members active without exposing siblings", async () => {
  const surface = await createSurface();
  const common = surface.session.search("document.set_table_cells_text").capabilities[0]!;
  assert.equal(common.loaded, true);
  const before = surface.session.search("document.set_table_cells_formatting");
  assert.equal(before.capabilities[0]?.loaded, false);
  assert.deepEqual(surface.session.search("document.set_table_cells_formatting"), before);
  assert.equal(surface.session.load(["document.set_table_cells_formatting"]).ok, true);
  const listed = surface.session.list("document.tables.styling");
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.capabilities.find(item => item.id === "document.set_table_cells_formatting")?.loaded, true);
  assert.equal(listed.capabilities.find(item => item.id === "document.set_table_cell_shading")?.loaded, false);
  assert.equal(surface.projectTools()["document.set_table_cell_shading"], undefined);
  const guidance = projectLoadedInstructions(surface.session)!;
  assert.match(JSON.stringify(guidance.message), /Loaded IDs: document.set_table_cells_formatting/);
  const error = surface.session.load(["document.tables.unknown"]);
  assert.equal(error.ok, false);
  if (error.ok || !("alternatives" in error)) return;
  assert.deepEqual(error.alternatives, ["document.tables.structure", "document.tables.styling"]);
});

test("new engine reads load dynamically and use the bound read host", async () => {
  let calls = 0;
  const tools = createDocumentTools({
    capabilities: () => ({ formats: [{ format: "docx", capabilities: ["read_business_summary"], operations: [{
      id: "read_business_summary", kind: "read", nodeExport: "readBusinessSummary", description: "Read the business summary",
      jsonInput: true, jsonOutput: false,
      inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    }] }] }),
    inspect: async () => ({}), find: async () => ({}),
    readOperation: async (capability, input) => { calls++; return { capability, label: input.label }; },
  });
  const surface = createToolSurface(tools);
  assert.equal(surface.initialTools["document.read_business_summary"], undefined);
  assert.ok(JSON.stringify(surface.session.search("business summary")).includes("document.read_business_summary"));
  assert.equal(surface.session.load(["document.read_business_summary"]).ok, true);
  const tool = surface.projectTools()["document.read_business_summary"]!;
  assert.equal(tool.kind, "read");
  assert.deepEqual(await tool.execute!({ label: "Sales" }, {} as never), { capability: "read_business_summary", label: "Sales" });
  assert.equal(calls, 1);
});

test("loading cannot execute a hidden sibling in the same turn", async () => {
  let calls = 0;
  const surface = createToolSurface({ "document.set_text_formatting": defineTool({ kind: "mutate", description: "format",
    inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => { calls++; return { ok: true }; } }) });
  let modelTurn = 0;
  const model = { specificationVersion: "v3", provider: "test", modelId: "test", supportedUrls: {},
    doStream: async () => {
      modelTurn++;
      const calls = modelTurn === 1
        ? [{ name: "capabilities_load", input: { ids: ["document.text"] } }, { name: "document_set_text_formatting", input: {} }]
        : [{ name: "document_set_text_formatting", input: {} }];
      return { stream: new ReadableStream({ start(controller) {
        for (const [index, call] of calls.entries()) controller.enqueue({ type: "tool-call", toolCallId: `call-${modelTurn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) });
        controller.enqueue({ type: "finish", finishReason: modelTurn === 2 ? "stop" : "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } });
        controller.close();
      } }) };
    },
  } as never;
  await runAgent({ model, messages: [{ role: "user", content: "format" }], tools: surface.tools, projectTools: surface.projectTools, maxTurns: 2 });
  assert.equal(calls, 1);
});

test("a loaded skill appears only on later model turns and composes with loaded tools", async () => {
  const events: CapabilityEvent[] = [];
  const surface = await createSurface((event) => { events.push(event); });
  const skillId = "skills.scientific-writing.scientific-paper";
  assert.equal(surface.capabilityIndex.includes("Never invent"), false);
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const prompt = JSON.stringify(options.prompt);
    const names = options.tools!.map((item) => item.name);
    assert.equal(prompt.includes("Never invent methods"), turn > 0);
    assert.equal((prompt.match(/<loaded_capabilities>/g) ?? []).length, turn > 0 ? 1 : 0);
    assert.equal(names.includes("document_set_text_formatting"), turn > 0);
    const calls = turn === 0 ? [{ name: "capabilities_load", input: { ids: [skillId, "document.text"] } }]
      : turn === 1 ? [{ name: "capabilities_list", input: { parentId: "skills" } }] : [];
    turn++;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      ...calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
      { type: "finish", finishReason: { unified: calls.length ? "tool-calls" as const : "stop" as const, raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  await runAgent({ model, messages: [{ role: "user", content: "Draft a paper" }], tools: surface.tools,
    projectTools: surface.projectTools,
    projectMessages: (messages) => {
      const guidance = projectLoadedInstructions(surface.session);
      return guidance ? [...messages, guidance.message] : messages;
    },
    maxTurns: 3 });
  assert.equal(turn, 3);
  assert.deepEqual(events.filter((event) => event.capabilityId === skillId).map((event) => [event.kind, event.type]),
    [["instruction", "loaded"]]);
  assert.equal(events.some((event) => event.capabilityId === skillId && ["executed", "succeeded"].includes(event.type)), false);
});

test("new engine JSON operations become discoverable without a product registration", async () => {
  let calls = 0;
  const tools = createDocumentTools({
    capabilities: () => ({ formats: [{ format: "docx", capabilities: ["new_business_edit"], operations: [{
      id: "new_business_edit", kind: "mutate", nodeExport: "executeDocxNewBusinessEdit", description: "Update a business value",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, jsonInput: true,
    }] }] }),
    inspect: async () => ({}), find: async () => ({}), mutate: async (capability, input) => { calls++; return { ok: true, capability, input }; },
  });
  const surface = createToolSurface(tools);
  assert.equal(surface.initialTools["document.new_business_edit"], undefined);
  assert.ok(surface.session.search("business").capabilities.some(item => item.id === "document.new_business_edit"));
  assert.equal(surface.session.load(["document.more_operations"]).ok, true);
  assert.ok(surface.projectTools()["document.new_business_edit"]);
  await surface.tools["document.new_business_edit"]!.execute!({ value: "New value" }, call);
  assert.equal(calls, 1);
});
