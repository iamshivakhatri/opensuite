import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  ArtifactHandleRegistry,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  createCapabilities,
  createDocumentCreateTableTool,
  createDocumentDeleteTableColumnTool,
  createDocumentDeleteTableRowTool,
  createDocumentDeleteTableTool,
  createDocumentInspectTool,
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

const TABLE_TOOLS = [
  DOCUMENT_TOOL_NAMES.createTable,
  DOCUMENT_TOOL_NAMES.deleteTable,
  DOCUMENT_TOOL_NAMES.deleteTableRow,
  DOCUMENT_TOOL_NAMES.deleteTableColumn,
  DOCUMENT_TOOL_NAMES.setTableCellsText,
  DOCUMENT_TOOL_NAMES.insertTableRows,
  DOCUMENT_TOOL_NAMES.insertTableColumn,
] as const;

test("table lifecycle tools expose when runtime advertises caps", () => {
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    mutableDocumentCapabilities(),
  ).map((t) => t.name);
  for (const name of TABLE_TOOLS) {
    assert.ok(names.includes(name), `expected ${name}`);
  }
});

test("absent create_table capability omits create_table tool", () => {
  const caps = createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.setTableCellsText,
    DOCX_ENGINE_CAPS.insertTableRows,
    DOCX_ENGINE_CAPS.insertTableColumn,
  );
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => t.name);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.createTable), false);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.deleteTable), false);
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.setTableCellsText));
});

test("PPTX/XLSX mock caps omit table lifecycle tools", () => {
  for (const format of ["pptx", "xlsx"] as const) {
    const names = filterDocumentToolsByCapabilities(
      listDocumentToolDescriptors(),
      mockCapabilitiesForFormat(format),
    ).map((t) => t.name);
    for (const name of [
      DOCUMENT_TOOL_NAMES.createTable,
      DOCUMENT_TOOL_NAMES.deleteTable,
      DOCUMENT_TOOL_NAMES.deleteTableRow,
      DOCUMENT_TOOL_NAMES.deleteTableColumn,
    ]) {
      assert.equal(names.includes(name), false, `${format} must omit ${name}`);
    }
  }
});

test("create_table maps matrix+placement to one persisted mutation", async () => {
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

  const result = await createDocumentCreateTableTool().execute(
    {
      rows: [
        ["Task", "Owner", "Deadline"],
        ["Prepare report", "J. Smith", "08/15/2027"],
        ["Meeting notes", "A. Patel", ""],
      ],
      placement: { kind: "end" },
    },
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  assert.notEqual(result.document.versionId, docxRef.versionId);
  assert.deepEqual(seen, {
    type: "document.create_table",
    baseVersionId: "ver-1",
    payload: {
      rows: [
        ["Task", "Owner", "Deadline"],
        ["Prepare report", "J. Smith", "08/15/2027"],
        ["Meeting notes", "A. Patel", ""],
      ],
      placement: { kind: "end" },
    },
  });
});

test("delete row/column/table each persist one version", async () => {
  const ops: string[] = [];
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      ops.push(operation.type);
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([ops.length]),
      };
    },
  };
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
  });

  const delRow = await createDocumentDeleteTableRowTool().execute(
    {
      table: { headerCells: ["Task", "Owner"] },
      row: { firstCellText: "Prepare report" },
    },
    ctx,
  );
  assert.equal(delRow.status, "success");

  const delCol = await createDocumentDeleteTableColumnTool().execute(
    {
      table: { headerCells: ["Task", "Owner"] },
      columnHeader: "Owner",
    },
    { ...ctx, primaryDocument: delRow.document },
  );
  assert.equal(delCol.status, "success");

  const delTable = await createDocumentDeleteTableTool().execute(
    { table: { headerCells: ["Task", "Owner"] } },
    { ...ctx, primaryDocument: delCol.document },
  );
  assert.equal(delTable.status, "success");

  assert.deepEqual(ops, [
    "document.delete_table_row",
    "document.delete_table_column",
    "document.delete_table",
  ]);
});

test("LAST_TABLE_ROW failure preserves diagnostic and does not advance", async () => {
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
        code: "PRECONDITION_FAILED",
        diagnostics: [
          {
            code: "PRECONDITION_FAILED",
            severity: "error",
            message: "cannot delete the last row",
            reasonCode: "LAST_TABLE_ROW",
            operation: "delete_table_row",
            targetHandle: "r0",
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      createDocumentDeleteTableRowTool().execute(
        {
          table: { headerCells: ["Task"] },
          row: { firstCellText: "Only" },
        },
        createFakeToolExecutionContext({
          primaryDocument: docxRef,
          runtime,
          mutations: createInMemoryDocumentMutationExecutor(runtime),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AgentCoreError);
      assert.equal(error.code, "TOOL_FAILURE");
      assert.equal(error.diagnostic?.reasonCode, "LAST_TABLE_ROW");
      assert.equal(error.diagnostic?.operation, "delete_table_row");
      assert.equal(error.diagnostic?.targetHandle, "r0");
      return true;
    },
  );
});

test("stale table handle rejected before runtime on delete_table", async () => {
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
        focus: { kind: "body_blocks" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          bodyBlocks: [
            {
              handle: "b0",
              kind: "paragraph",
              text: "Anchor",
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
  const create = createDocumentCreateTableTool();
  const del = createDocumentDeleteTableTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
    handles,
  });

  await inspect.execute({ focus: { kind: "body_blocks" } }, ctx);
  // Register a fake table handle on the current version, then mutate.
  handles.register("t0", docxRef.versionId);
  const created = await create.execute(
    {
      rows: [["A"], ["b"]],
      placement: { kind: "after", handle: "b0" },
    },
    ctx,
  );
  assert.equal(created.status, "success");
  const afterCreate = executeCount;

  await assert.rejects(
    () =>
      del.execute(
        { table: { handle: "t0" } },
        { ...ctx, primaryDocument: created.document },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
  assert.equal(executeCount, afterCreate);
});
