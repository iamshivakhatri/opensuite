import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  ArtifactHandleRegistry,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  createCapabilities,
  createDocumentInspectTool,
  createDocumentSetTableFormattingTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mockCapabilitiesForFormat,
  mutableDocumentCapabilities,
  type DocumentRef,
  type DocumentRuntime,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("set_table_formatting tool exposes when runtime advertises cap", () => {
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    mutableDocumentCapabilities(),
  ).map((t) => t.name);
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.setTableFormatting));
});

test("absent set_table_formatting capability omits tool", () => {
  const caps = createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.createTable,
    DOCX_ENGINE_CAPS.deleteTable,
  );
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => t.name);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.setTableFormatting), false);
});

test("PPTX/XLSX mock caps omit set_table_formatting", () => {
  for (const format of ["pptx", "xlsx"] as const) {
    const names = filterDocumentToolsByCapabilities(
      listDocumentToolDescriptors(),
      mockCapabilitiesForFormat(format),
    ).map((t) => t.name);
    assert.equal(
      names.includes(DOCUMENT_TOOL_NAMES.setTableFormatting),
      false,
      `${format} must omit set_table_formatting`,
    );
  }
});

test("set_table_formatting maps args to one persisted mutation", async () => {
  let seen: unknown;
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      executeCount += 1;
      seen = operation;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  };

  const result = await createDocumentSetTableFormattingTool().execute(
    {
      table: { handle: "t0" },
      alignment: "center",
      borders: "none",
      cellMarginTopTwips: 120,
      cellMarginRightTwips: 120,
      cellMarginBottomTwips: 120,
      cellMarginLeftTwips: 120,
    },
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      handles: (() => {
        const registry = new ArtifactHandleRegistry();
        registry.register("t0", docxRef.versionId);
        return registry;
      })(),
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  assert.notEqual(result.document.versionId, docxRef.versionId);
  assert.deepEqual(seen, {
    type: "document.set_table_formatting",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      alignment: "center",
      borders: "none",
      cellMarginTopTwips: 120,
      cellMarginRightTwips: 120,
      cellMarginBottomTwips: 120,
      cellMarginLeftTwips: 120,
    },
  });
});

test("engine refusal preserves diagnostic and does not advance", async () => {
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      return {
        status: "error",
        code: "UNSUPPORTED_OPERATION",
        diagnostics: [
          {
            code: "UNSUPPORTED_OPERATION",
            severity: "error",
            message: "complex table",
            reasonCode: "NESTED_TABLE",
            operation: "set_table_formatting",
            targetHandle: "t0",
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      createDocumentSetTableFormattingTool().execute(
        { table: { headerCells: ["A", "B"] }, alignment: "center" },
        createFakeToolExecutionContext({
          primaryDocument: docxRef,
          runtime,
          mutations: createInMemoryDocumentMutationExecutor(runtime),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AgentCoreError);
      assert.equal(error.code, "TOOL_FAILURE");
      assert.equal(error.diagnostic?.reasonCode, "NESTED_TABLE");
      assert.equal(error.diagnostic?.operation, "set_table_formatting");
      assert.equal(error.diagnostic?.targetHandle, "t0");
      return true;
    },
  );
});

test("stale table handle rejected before runtime on set_table_formatting", async () => {
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
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
              affordances: [
                { capability: "set_table_formatting", supported: true },
              ],
              rows: [],
            },
          ],
        },
      };
    },
    async execute() {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([executeCount]),
      };
    },
  };

  const handles = new ArtifactHandleRegistry();
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const inspect = createDocumentInspectTool();
  const format = createDocumentSetTableFormattingTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
    handles,
  });

  await inspect.execute({ focus: { kind: "tables" } }, ctx);
  const formatted = await format.execute(
    { table: { handle: "t0" }, alignment: "center" },
    ctx,
  );
  assert.equal(formatted.status, "success");
  const afterFormat = executeCount;

  await assert.rejects(
    () =>
      format.execute(
        { table: { handle: "t0" }, borders: "none" },
        { ...ctx, primaryDocument: formatted.document },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
  assert.equal(executeCount, afterFormat);

  const ctx2 = {
    ...ctx,
    primaryDocument: formatted.document,
    handles: new ArtifactHandleRegistry(),
  };
  await inspect.execute({ focus: { kind: "tables" } }, ctx2);
  const again = await format.execute(
    { table: { handle: "t0" }, borders: "grid" },
    ctx2,
  );
  assert.equal(again.status, "success");
  assert.equal(executeCount, afterFormat + 1);
});

test("set_table_formatting affordance reaches model unchanged", async () => {
  const inspection = {
    status: "success" as const,
    format: "docx" as const,
    capabilities: mutableDocumentCapabilities(),
    diagnostics: [],
    focus: { kind: "tables" as const },
    payload: {
      format: "docx" as const,
      summary: { title: null, unitKind: "page" as const, unitCount: 1 },
      tables: [
        {
          handle: "t0",
          rowCount: 2,
          cols: 2,
          affordances: [
            {
              capability: "set_table_formatting",
              supported: false,
              reason: "MERGED_CELLS",
            },
          ],
          rows: [],
        },
      ],
    },
  };

  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      return inspection;
    },
  };

  const result = await createDocumentInspectTool().execute(
    { focus: { kind: "tables" } },
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
      handles: new ArtifactHandleRegistry(),
    }),
  );

  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.payload.format, "docx");
  if (result.payload.format !== "docx") return;
  const table = result.payload.tables?.[0];
  assert.ok(table);
  assert.deepEqual(table.affordances, [
    {
      capability: "set_table_formatting",
      supported: false,
      reason: "MERGED_CELLS",
    },
  ]);
});
