import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  MOCK_FORMAT_CAPS,
  ToolRegistry,
  createCapabilities,
  createDocumentAgentRunnerOptions,
  createDocumentInsertTableColumnTool,
  createDocumentToolRegistry,
  createFakeTool,
  createMockDocumentRuntime,
  createScriptedAgentModel,
  discoverDocumentToolsFromRuntime,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mockCapabilitiesForFormat,
  mutableDocumentCapabilities,
  readOnlyDocumentCapabilities,
  assistantOnlyResponse,
  type DocumentRef,
  type ModelRequest,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

test("DOCX advertised caps → first model request gets exactly those document tools", async () => {
  const caps = createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.replaceText,
    DOCX_ENGINE_CAPS.setTableCellsText,
    DOCX_ENGINE_CAPS.insertTableRows,
  );
  const runtime = createMockDocumentRuntime({ capabilities: caps });
  const systemTool = createFakeTool({
    name: "agent.ping",
    execute: async () => ({ ok: true }),
  });

  let firstTools: string[] | undefined;
  const model = createScriptedAgentModel([
    (request: ModelRequest) => {
      firstTools = request.tools.map((t) => t.name).sort();
      return assistantOnlyResponse("done");
    },
  ]);

  const runner = new AgentRunner({
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([systemTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "ping",
    threadId: "t1",
    runId: "r-caps-docx",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(firstTools, [
    "agent.ping",
    DOCUMENT_TOOL_NAMES.find,
    DOCUMENT_TOOL_NAMES.insertTableRows,
    DOCUMENT_TOOL_NAMES.inspect,
    DOCUMENT_TOOL_NAMES.replaceText,
    DOCUMENT_TOOL_NAMES.setTableCellsText,
  ]);
  assert.ok(!firstTools!.includes(DOCUMENT_TOOL_NAMES.insertTableColumn));
  assert.ok(!firstTools!.includes(DOCUMENT_TOOL_NAMES.updateSlideText));
});

test("inspect+find only → mutation tools absent from first model request", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: readOnlyDocumentCapabilities(),
  });
  let firstTools: string[] | undefined;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request: ModelRequest) => {
        firstTools = request.tools.map((t) => t.name).sort();
        return assistantOnlyResponse("read-only");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    instruction: "what is this?",
    threadId: "t1",
    runId: "r-readonly",
    primaryDocument: docxRef,
  });

  assert.deepEqual(firstTools, [
    DOCUMENT_TOOL_NAMES.find,
    DOCUMENT_TOOL_NAMES.inspect,
  ]);
});

test("PPTX/XLSX mock caps derive tools without format hardcoding", () => {
  const pptx = createDocumentToolRegistry(mockCapabilitiesForFormat("pptx"))
    .list()
    .map((t) => t.name);
  assert.ok(pptx.includes(DOCUMENT_TOOL_NAMES.updateSlideText));
  assert.ok(!pptx.includes(DOCUMENT_TOOL_NAMES.replaceText));
  assert.ok(!pptx.includes(DOCUMENT_TOOL_NAMES.setCells));

  const xlsx = createDocumentToolRegistry(mockCapabilitiesForFormat("xlsx"))
    .list()
    .map((t) => t.name);
  assert.ok(xlsx.includes(DOCUMENT_TOOL_NAMES.setCells));
  assert.ok(!xlsx.includes(DOCUMENT_TOOL_NAMES.replaceText));
  assert.ok(!xlsx.includes(DOCUMENT_TOOL_NAMES.updateSlideText));
});

test("capability discovery failure does not expose all document tools", async () => {
  let capabilityCalls = 0;
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const failingRuntime = {
    ...runtime,
    capabilities() {
      capabilityCalls += 1;
      throw new Error("engine unavailable");
    },
  };

  let modelCalled = false;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalled = true;
        return assistantOnlyResponse("should not run");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime: failingRuntime,
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "edit this",
    threadId: "t1",
    runId: "r-fail-caps",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0]?.code, "CAPABILITY_DISCOVERY_FAILED");
  assert.equal(modelCalled, false);
  assert.equal(capabilityCalls, 1);
});

test("discoverDocumentToolsFromRuntime calls capabilities once", async () => {
  let capabilityCalls = 0;
  const base = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runtime = {
    ...base,
    capabilities(document: DocumentRef) {
      capabilityCalls += 1;
      return base.capabilities(document);
    },
  };

  const discovered = await discoverDocumentToolsFromRuntime(runtime, docxRef);
  assert.equal(capabilityCalls, 1);
  assert.ok(
    discovered.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.replaceText),
  );
});

test("direct invoke of absent-capability tool still fails safely", async () => {
  const tool = createDocumentInsertTableColumnTool();
  const runtime = createMockDocumentRuntime({
    capabilities: createCapabilities(
      Capabilities.DocumentInspect,
      Capabilities.DocumentFind,
      Capabilities.DocumentMutate,
      DOCX_ENGINE_CAPS.replaceText,
    ),
  });
  await assert.rejects(
    () =>
      tool.execute(
        tool.parseInput({
          table: { headerCells: ["A", "B"] },
          afterColumnHeader: "A",
          header: "C",
          cells: ["x"],
        }),
        {
          runId: "r",
          primaryDocument: docxRef,
          signal: new AbortController().signal,
          events: { emit() {} },
          runtime,
        },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.code === "UNSUPPORTED_CAPABILITY",
  );
});

test("filterDocumentToolsByCapabilities is capability-only", () => {
  const filtered = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    createCapabilities(
      Capabilities.DocumentInspect,
      MOCK_FORMAT_CAPS.updateSlideText,
    ),
  ).map((t) => t.name);
  assert.ok(filtered.includes(DOCUMENT_TOOL_NAMES.inspect));
  assert.ok(filtered.includes(DOCUMENT_TOOL_NAMES.updateSlideText));
  assert.ok(!filtered.includes(DOCUMENT_TOOL_NAMES.find));
  assert.ok(!filtered.includes(DOCUMENT_TOOL_NAMES.replaceText));
});

test("bootstrap discovery is once per run across model turns", async () => {
  let capabilityCalls = 0;
  const base = createMockDocumentRuntime({
    capabilities: readOnlyDocumentCapabilities(),
  });
  const runtime = {
    ...base,
    capabilities(document: DocumentRef) {
      capabilityCalls += 1;
      return base.capabilities(document);
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request) => {
        assert.ok(request.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.inspect));
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: DOCUMENT_TOOL_NAMES.inspect,
              input: { focus: { kind: "overview" } },
            },
          ],
        };
      },
      () => assistantOnlyResponse("ok"),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "inspect",
    threadId: "t1",
    runId: "r-once",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");
  // Bootstrap once; inspect execute may call capabilities again for defensive gate.
  assert.ok(capabilityCalls >= 1);
  assert.equal(capabilityCalls, 2); // bootstrap + inspect requireCapability
});
