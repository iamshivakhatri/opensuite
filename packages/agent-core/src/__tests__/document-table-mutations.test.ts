import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCUMENT_TOOL_NAMES,
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentSetTableCellsTextTool,
  createDocumentToolRegistry,
  createFakeDocumentRuntime,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createRecordingEventSink,
  createScriptedAgentModel,
  mutableDocumentCapabilities,
  assistantOnlyResponse,
  toolCallResponse,
  AgentRunner,
  type DocumentRef,
  type InspectionResult,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-table",
  versionId: "ver-1",
  format: "docx",
};

const TABLE = { headerCells: ["Name", "Role"] as const };

test("tool schemas represent multi-cell, multi-row, and column ops", () => {
  const setCells = createDocumentSetTableCellsTextTool();
  const insertRows = createDocumentInsertTableRowsTool();
  const insertColumn = createDocumentInsertTableColumnTool();

  assert.deepEqual(
    setCells.parseInput({
      table: TABLE,
      updates: [
        {
          rowLabel: "Alice",
          columnHeader: "Role",
          expectedCurrentText: "CEO",
          replacement: "Founder & CEO",
        },
        {
          rowLabel: "Bob",
          columnHeader: "Role",
          expectedCurrentText: "CTO",
          replacement: "CTO & VP Engineering",
        },
      ],
    }).updates.map((u) => u.replacement),
    ["Founder & CEO", "CTO & VP Engineering"],
  );

  assert.deepEqual(
    insertRows.parseInput({
      table: TABLE,
      after: { firstCellText: "Bob" },
      rows: [
        ["Charlie", "CFO"],
        ["David", "COO"],
      ],
    }).rows,
    [
      ["Charlie", "CFO"],
      ["David", "COO"],
    ],
  );

  assert.deepEqual(
    insertColumn.parseInput({
      table: TABLE,
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["New York", "Seattle"],
    }),
    {
      table: TABLE,
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["New York", "Seattle"],
    },
  );

  assert.match(setCells.description, /atomic/i);
  assert.match(insertRows.description, /exactly one string per column/i);
  assert.match(insertColumn.description, /one column/i);
});

test("registry exposes table mutation tools when Rust caps are advertised", () => {
  const names = createDocumentToolRegistry(mutableDocumentCapabilities(), {
    format: "docx",
  })
    .list()
    .map((tool) => tool.name);
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.setTableCellsText));
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.insertTableRows));
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.insertTableColumn));
});

test("set_table_cells_text persists once, advances DocumentRef, re-inspect sees N+1", async () => {
  let executeCount = 0;
  let latestVersion = "ver-1";
  const tablesByVersion: Record<string, string[][]> = {
    "ver-1": [
      ["Name", "Role"],
      ["Alice", "CEO"],
      ["Bob", "CTO"],
    ],
    "ver-1+1": [
      ["Name", "Role"],
      ["Alice", "Founder & CEO"],
      ["Bob", "CTO & VP Engineering"],
    ],
  };

  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async inspect(document): Promise<InspectionResult> {
      const rows = tablesByVersion[document.versionId] ?? tablesByVersion["ver-1"]!;
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        diagnostics: [],
        focus: { kind: "tables" },
        payload: {
          format: "docx",
          summary: {
            title: null,
            unitKind: "page",
            unitCount: 1,
          },
          page: { total: 1, offset: 0, returned: 1, hasMore: false },
          tables: [
            {
              handle: "t1",
              occurrence: 1,
              rows: rows.length,
              cols: 2,
              isRectangular: true,
              cells: rows,
            },
          ],
        },
      };
    },
    async execute(_document, operation) {
      executeCount += 1;
      assert.equal(operation.type, "document.set_table_cells_text");
      latestVersion = "ver-1+1";
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.set_table_cells_text",
          area: "table",
          before: "CEO",
          after: "Founder & CEO",
        },
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  });

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "i1",
          name: DOCUMENT_TOOL_NAMES.inspect,
          input: { focus: { kind: "tables" } },
        },
      ]),
      toolCallResponse("", [
        {
          id: "u1",
          name: DOCUMENT_TOOL_NAMES.setTableCellsText,
          input: {
            table: TABLE,
            updates: [
              {
                rowLabel: "Alice",
                columnHeader: "Role",
                expectedCurrentText: "CEO",
                replacement: "Founder & CEO",
              },
              {
                rowLabel: "Bob",
                columnHeader: "Role",
                expectedCurrentText: "CTO",
                replacement: "CTO & VP Engineering",
              },
            ],
          },
        },
      ]),
      toolCallResponse("", [
        {
          id: "i2",
          name: DOCUMENT_TOOL_NAMES.inspect,
          input: { focus: { kind: "tables" } },
        },
      ]),
      assistantOnlyResponse("Updated roles"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities(), {
      format: "docx",
    }),
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Update roles",
    threadId: "t1",
    runId: "run-set-cells",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(executeCount, 1);
  assert.equal(latestVersion, "ver-1+1");
  assert.equal(
    events.events.filter((e) => e.type === "document.version.advanced").length,
    1,
  );
  const secondInspect = result.toolOutcomes.find(
    (o) => o.toolCallId === "i2" && o.status === "succeeded",
  );
  assert.ok(secondInspect);
});

test("insert_table_rows persists once and advances DocumentRef", async () => {
  let executeCount = 0;
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute(_document, operation) {
      executeCount += 1;
      assert.equal(operation.type, "document.insert_table_rows");
      assert.deepEqual(operation.payload.rows, [
        ["Charlie", "CFO"],
        ["David", "COO"],
      ]);
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.insert_table_rows",
          area: "table",
          before: "",
          after: "Charlie|CFO",
        },
        artifactBytes: new Uint8Array([9]),
      };
    },
  });

  const tool = createDocumentInsertTableRowsTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  });
  const result = await tool.execute(
    {
      table: TABLE,
      after: { firstCellText: "Bob" },
      rows: [
        ["Charlie", "CFO"],
        ["David", "COO"],
      ],
    },
    ctx,
  );
  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  if (result.status === "success") {
    assert.equal(result.document.versionId, "ver-1+1");
    assert.equal(result.baseVersionId, "ver-1");
  }
});

test("insert_table_column persists once", async () => {
  let executeCount = 0;
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute(_document, operation) {
      executeCount += 1;
      assert.equal(operation.type, "document.insert_table_column");
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.insert_table_column",
          area: "table",
          before: "",
          after: "Location",
        },
        artifactBytes: new Uint8Array([7]),
      };
    },
  });

  const tool = createDocumentInsertTableColumnTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  });
  const result = await tool.execute(
    {
      table: TABLE,
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["New York", "Seattle"],
    },
    ctx,
  );
  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
});

test("table mutation precondition failure does not advance DocumentRef", async () => {
  const events = createRecordingEventSink();
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute() {
      return {
        status: "error",
        code: "PRECONDITION_FAILED",
        diagnostics: [
          {
            code: "PRECONDITION_FAILED",
            severity: "error",
            message: "expected current text mismatch",
          },
        ],
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "u1",
          name: DOCUMENT_TOOL_NAMES.setTableCellsText,
          input: {
            table: TABLE,
            updates: [
              {
                rowLabel: "Alice",
                columnHeader: "Role",
                expectedCurrentText: "WRONG",
                replacement: "X",
              },
            ],
          },
        },
      ]),
      assistantOnlyResponse("failed"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities(), {
      format: "docx",
    }),
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "bad precondition",
    threadId: "t1",
    runId: "run-precond",
    primaryDocument: docxRef,
  });

  assert.equal(
    result.toolOutcomes.find(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.setTableCellsText,
    )?.status,
    "failed",
  );
  assert.equal(
    events.events.some((e) => e.type === "document.version.advanced"),
    false,
  );
});

test("UNSUPPORTED_OPERATION for column insert does not advance", async () => {
  const events = createRecordingEventSink();
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute() {
      return {
        status: "error",
        code: "UNSUPPORTED_OPERATION",
        diagnostics: [
          {
            code: "UNSUPPORTED_OPERATION",
            severity: "error",
            message: "merged table",
          },
        ],
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: DOCUMENT_TOOL_NAMES.insertTableColumn,
          input: {
            table: TABLE,
            afterColumnHeader: "Role",
            header: "Location",
            cells: ["A", "B"],
          },
        },
      ]),
      assistantOnlyResponse("unsupported"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities(), {
      format: "docx",
    }),
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "add column",
    threadId: "t1",
    runId: "run-unsup",
    primaryDocument: docxRef,
  });

  assert.equal(
    result.toolOutcomes.find(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.insertTableColumn,
    )?.status,
    "failed",
  );
  assert.equal(
    events.events.some((e) => e.type === "document.version.advanced"),
    false,
  );
});
