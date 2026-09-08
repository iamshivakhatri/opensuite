import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  ArtifactHandleRegistry,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  collectOpaqueHandles,
  collectOpaqueHandlesFromToolInput,
  createCapabilities,
  createDocumentAgentRunnerOptions,
  createDocumentInsertTableRowsTool,
  createDocumentInspectTool,
  createDocumentSetTableCellsTextTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createMockDocumentRuntime,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  requireCurrentArtifactHandles,
  assistantOnlyResponse,
  type DocumentRef,
  type DocumentRuntime,
  type InspectionResult,
} from "../index.js";

const v1: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("collectOpaqueHandles is generic and does not parse syntax", () => {
  const handles = collectOpaqueHandles({
    format: "docx",
    tables: [
      {
        handle: "t0",
        rows: [
          {
            handle: "t0:r0",
            cells: [
              { handle: "t0:r0:c0", text: "A" },
              { handle: "t0:r0:c1", text: "B" },
            ],
          },
        ],
      },
    ],
    headings: [{ handle: "docx:h:1", text: "Title" }],
  });
  assert.deepEqual(handles.sort(), [
    "docx:h:1",
    "t0",
    "t0:r0",
    "t0:r0:c0",
    "t0:r0:c1",
  ]);
});

test("collectOpaqueHandlesFromToolInput finds handle and *Handle keys", () => {
  const handles = collectOpaqueHandlesFromToolInput({
    table: { handle: "t0", headerCells: ["A"] },
    afterColumnHandle: "t0:c1",
    updates: [{ target: { handle: "t0:r0:c0" }, expectedCurrentText: "x", replacement: "y" }],
  });
  assert.deepEqual(handles.sort(), ["t0", "t0:c1", "t0:r0:c0"]);
});

test("current handle succeeds and reaches runtime", async () => {
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.insert_table_rows",
          area: "table",
          before: "",
          after: "ok",
        },
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  const registry = new ArtifactHandleRegistry();
  registry.register("t0", v1.versionId);
  registry.register("t0:r1", v1.versionId);

  const tool = createDocumentInsertTableRowsTool();
  const result = await tool.execute(
    {
      table: { handle: "t0" },
      after: { handle: "t0:r1" },
      rows: [["X", "Y"]],
    },
    createFakeToolExecutionContext({
      primaryDocument: v1,
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      handles: registry,
    }),
  );
  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
});

test("successful mutation makes previous handle stale — Rust not called", async () => {
  let executeCount = 0;
  const base = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect(document, options) {
      return base.inspect(document, options);
    },
    async execute(document, operation, options) {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: operation.type,
          area: "table",
          before: "",
          after: "ok",
        },
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  };

  const registry = new ArtifactHandleRegistry();
  registry.register("t0", "ver-1");
  registry.register("t0:r1", "ver-1");

  let primary: DocumentRef = { ...v1 };
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const insert = createDocumentInsertTableRowsTool();
  const setCells = createDocumentSetTableCellsTextTool();

  const ctx1 = createFakeToolExecutionContext({
    primaryDocument: primary,
    runtime,
    mutations,
    handles: registry,
    advancePrimaryDocument: (next) => {
      primary = next;
    },
  });

  const first = await insert.execute(
    {
      table: { handle: "t0" },
      after: { handle: "t0:r1" },
      rows: [["New", "Row"]],
    },
    ctx1,
  );
  assert.equal(first.status, "success");
  assert.equal(executeCount, 1);
  assert.notEqual(primary.versionId, "ver-1");

  const ctx2 = createFakeToolExecutionContext({
    primaryDocument: primary,
    runtime,
    mutations,
    handles: registry,
  });

  await assert.rejects(
    () =>
      setCells.execute(
        {
          table: { handle: "t0" },
          updates: [
            {
              target: { handle: "t0:r1" },
              expectedCurrentText: "x",
              replacement: "y",
            },
          ],
        },
        ctx2,
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
  assert.equal(executeCount, 1); // Rust/runtime not called again
});

test("re-inspection revalidates the same positional handle string", async () => {
  const registry = new ArtifactHandleRegistry();
  registry.register("t0:r1:c0", "ver-1");
  assert.equal(registry.origin("t0:r1:c0"), "ver-1");

  // Advance conceptual current version; old registration remains for stale detection.
  const current = "ver-2";
  assert.notEqual(registry.origin("t0:r1:c0"), current);

  // Fresh inspect of v2 returns same string → update registry.
  registry.register("t0:r1:c0", current);
  assert.equal(registry.origin("t0:r1:c0"), current);

  const ctx = createFakeToolExecutionContext({
    primaryDocument: { ...v1, versionId: current },
    handles: registry,
  });
  assert.doesNotThrow(() =>
    requireCurrentArtifactHandles(ctx, { target: { handle: "t0:r1:c0" } }),
  );
});

test("failed mutation does not invalidate current handles", async () => {
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      executeCount += 1;
      return {
        status: "error",
        code: "PRECONDITION_FAILED",
        diagnostics: [
          {
            code: "PRECONDITION_FAILED",
            severity: "error",
            message: "expected text mismatch",
          },
        ],
      };
    },
  };

  const registry = new ArtifactHandleRegistry();
  registry.register("t0", "ver-1");
  registry.register("t0:r0:c0", "ver-1");

  const tool = createDocumentSetTableCellsTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: v1,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    handles: registry,
  });

  await assert.rejects(() =>
    tool.execute(
      {
        table: { handle: "t0" },
        updates: [
          {
            target: { handle: "t0:r0:c0" },
            expectedCurrentText: "A",
            replacement: "B",
          },
        ],
      },
      ctx,
    ),
  );
  assert.equal(executeCount, 1);
  assert.equal(registry.origin("t0"), "ver-1");
  assert.doesNotThrow(() =>
    requireCurrentArtifactHandles(ctx, { table: { handle: "t0" } }),
  );
});

test("unknown invented handle rejected before runtime", async () => {
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  const tool = createDocumentSetTableCellsTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: v1,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    handles: new ArtifactHandleRegistry(),
  });

  await assert.rejects(
    () =>
      tool.execute(
        {
          table: { handle: "invented" },
          updates: [
            {
              target: { handle: "also-invented" },
              expectedCurrentText: "a",
              replacement: "b",
            },
          ],
        },
        ctx,
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "UNKNOWN_HANDLE",
  );
  assert.equal(executeCount, 0);
});

test("multiple handles: one stale rejects entire operation", async () => {
  const registry = new ArtifactHandleRegistry();
  registry.register("t0", "ver-2"); // current
  registry.register("t0:r0:c0", "ver-1"); // stale
  const ctx = createFakeToolExecutionContext({
    primaryDocument: { ...v1, versionId: "ver-2" },
    handles: registry,
  });
  assert.throws(
    () =>
      requireCurrentArtifactHandles(ctx, {
        table: { handle: "t0" },
        updates: [{ target: { handle: "t0:r0:c0" } }],
      }),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
});

test("semantic selector without handles is not blocked by registry", async () => {
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.set_table_cells_text",
          area: "table",
          before: "A",
          after: "B",
        },
        artifactBytes: new Uint8Array([9]),
      };
    },
  };

  const tool = createDocumentSetTableCellsTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: v1,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    handles: new ArtifactHandleRegistry(), // empty — fine for semantic path
  });

  const result = await tool.execute(
    {
      table: { headerCells: ["Name", "Role"] },
      updates: [
        {
          target: { rowLabel: "Alice", columnHeader: "Role" },
          expectedCurrentText: "CEO",
          replacement: "CFO",
        },
      ],
    },
    ctx,
  );
  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
});

test("document.inspect registers handles for the inspected version", async () => {
  const inspection: InspectionResult = {
    status: "success",
    format: "docx",
    capabilities: createCapabilities(Capabilities.DocumentInspect),
    diagnostics: [],
    focus: { kind: "tables" },
    payload: {
      format: "docx",
      summary: { title: null, unitKind: "page", unitCount: 1 },
      tables: [
        {
          handle: "t0",
          rowCount: 1,
          cols: 1,
          rows: [
            {
              handle: "t0:r0",
              cells: [{ handle: "t0:r0:c0", text: "A" }],
            },
          ],
        },
      ],
    },
  };

  const runtime: DocumentRuntime = {
    capabilities: () => createCapabilities(Capabilities.DocumentInspect),
    async inspect() {
      return inspection;
    },
  };

  const registry = new ArtifactHandleRegistry();
  const tool = createDocumentInspectTool();
  await tool.execute(
    { focus: { kind: "tables" } },
    createFakeToolExecutionContext({
      primaryDocument: v1,
      runtime,
      handles: registry,
    }),
  );

  assert.equal(registry.origin("t0"), "ver-1");
  assert.equal(registry.origin("t0:r0"), "ver-1");
  assert.equal(registry.origin("t0:r0:c0"), "ver-1");
});

test("AgentRunner end-to-end: stale handle after advance never reaches execute", async () => {
  let executeCount = 0;
  const base = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect(document, options) {
      const result = await base.inspect(document, options);
      if (result.status !== "success" || result.payload.format !== "docx") {
        return result;
      }
      // Ensure tables focus returns handles for registration.
      if (options?.focus?.kind === "tables") {
        return {
          ...result,
          payload: {
            format: "docx",
            summary: result.payload.summary,
            tables: [
              {
                handle: "t0",
                rowCount: 2,
                cols: 2,
                rows: [
                  {
                    handle: "t0:r0",
                    cells: [
                      { handle: "t0:r0:c0", text: "Name" },
                      { handle: "t0:r0:c1", text: "Role" },
                    ],
                  },
                  {
                    handle: "t0:r1",
                    cells: [
                      { handle: "t0:r1:c0", text: "Alice" },
                      { handle: "t0:r1:c1", text: "CEO" },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return result;
    },
    async execute(_document, operation) {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: operation.type,
          area: "table",
          before: "",
          after: "ok",
        },
        artifactBytes: new Uint8Array([4, 5, 6]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => ({
        content: "",
        toolCalls: [
          {
            id: "i1",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "tables" } },
          },
        ],
      }),
      () => ({
        content: "",
        toolCalls: [
          {
            id: "m1",
            name: DOCUMENT_TOOL_NAMES.insertTableRows,
            input: {
              table: { handle: "t0" },
              after: { handle: "t0:r1" },
              rows: [["Bob", "CTO"]],
            },
          },
        ],
      }),
      () => ({
        content: "",
        toolCalls: [
          {
            id: "m2",
            name: DOCUMENT_TOOL_NAMES.setTableCellsText,
            input: {
              table: { handle: "t0" },
              updates: [
                {
                  target: { handle: "t0:r1:c0" },
                  expectedCurrentText: "Alice",
                  replacement: "Alicia",
                },
              ],
            },
          },
        ],
      }),
      () => assistantOnlyResponse("done"),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: v1,
    }),
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "edit table",
    threadId: "t1",
    runId: "r-stale",
    primaryDocument: v1,
  });

  assert.equal(result.status, "completed");
  assert.equal(executeCount, 1); // only insert_table_rows; stale set_cells blocked
  const stale = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.setTableCellsText,
  );
  assert.equal(stale?.status, "failed");
  assert.equal(stale?.diagnostic?.code, "STALE_HANDLE");
});
