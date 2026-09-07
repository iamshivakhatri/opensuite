import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  createDocumentInsertTableRowsTool,
  createDocumentSetTableCellsTextTool,
  createFakeDocumentRuntime,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  mutableDocumentCapabilities,
  normalizeOptionalOccurrence,
  parseOptionalOccurrence,
  type DocumentRef,
} from "../index.js";

test("normalizeOptionalOccurrence sentinels and keeps 1-based values", () => {
  assert.equal(normalizeOptionalOccurrence(undefined), undefined);
  assert.equal(normalizeOptionalOccurrence(null), undefined);
  assert.equal(normalizeOptionalOccurrence(""), undefined);
  assert.equal(normalizeOptionalOccurrence(0), undefined);
  assert.equal(normalizeOptionalOccurrence(1), 1);
  assert.equal(normalizeOptionalOccurrence(2), 2);
  assert.equal(normalizeOptionalOccurrence(-1), -1);
  assert.equal(normalizeOptionalOccurrence(1.5), 1.5);
  assert.equal(normalizeOptionalOccurrence("abc"), "abc");
});

test("parseOptionalOccurrence accepts omit sentinels and rejects invalid", () => {
  assert.equal(parseOptionalOccurrence(undefined, "x"), undefined);
  assert.equal(parseOptionalOccurrence(null, "x"), undefined);
  assert.equal(parseOptionalOccurrence("", "x"), undefined);
  assert.equal(parseOptionalOccurrence(0, "x"), undefined);
  assert.equal(parseOptionalOccurrence(1, "x"), 1);
  assert.equal(parseOptionalOccurrence(2, "x"), 2);
  assert.throws(
    () => parseOptionalOccurrence(-1, "x"),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "INVALID_TOOL_INPUT",
  );
  assert.throws(
    () => parseOptionalOccurrence(1.5, "x"),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "INVALID_TOOL_INPUT",
  );
  assert.throws(
    () => parseOptionalOccurrence("abc", "x"),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "INVALID_TOOL_INPUT",
  );
});

test("insert_table_rows parseInput normalizes occurrence 0 before execute", () => {
  const tool = createDocumentInsertTableRowsTool();
  const parsed = tool.parseInput({
    table: { headerCells: ["Name", "Role"], occurrence: 0 },
    after: { firstCellText: "Bob", occurrence: 0 },
    rows: [["Charlie", "CFO"]],
  });
  assert.deepEqual(parsed, {
    table: { headerCells: ["Name", "Role"] },
    after: { firstCellText: "Bob" },
    rows: [["Charlie", "CFO"]],
  });
  assert.equal(Object.hasOwn(parsed.table, "occurrence"), false);
  assert.equal(Object.hasOwn(parsed.after, "occurrence"), false);
});

test("insert_table_rows parseInput keeps explicit occurrence 1 and 2", () => {
  const tool = createDocumentInsertTableRowsTool();
  const one = tool.parseInput({
    table: { headerCells: ["Name", "Role"], occurrence: 1 },
    after: { firstCellText: "Bob", occurrence: 2 },
    rows: [["Charlie", "CFO"]],
  });
  assert.equal(one.table.occurrence, 1);
  assert.equal(one.after.occurrence, 2);
});

test("set_table_cells_text parseInput normalizes null/empty occurrence", () => {
  const tool = createDocumentSetTableCellsTextTool();
  const parsed = tool.parseInput({
    table: { headerCells: ["Name", "Role"], occurrence: null },
    updates: [
      {
        rowLabel: "Alice",
        columnHeader: "Role",
        expectedCurrentText: "CEO",
        replacement: "Founder",
        occurrence: "",
      },
    ],
  });
  assert.equal(Object.hasOwn(parsed.table, "occurrence"), false);
  assert.equal(
    Object.hasOwn(parsed.updates[0]!.target as object, "occurrence"),
    false,
  );
  assert.deepEqual(parsed.updates[0]!.target, {
    rowLabel: "Alice",
    columnHeader: "Role",
  });
});

test("insert_table_rows with occurrence 0 reaches mutations/runtime once", async () => {
  const docRef: DocumentRef = {
    documentId: "doc-1",
    versionId: "ver-1",
    format: "docx",
  };
  let executeCount = 0;
  const seenPayloads: unknown[] = [];

  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute(_document, operation) {
      executeCount += 1;
      seenPayloads.push(operation.payload);
      assert.equal(operation.type, "document.insert_table_rows");
      assert.equal(
        Object.hasOwn(operation.payload.table as object, "occurrence"),
        false,
      );
      assert.equal(
        Object.hasOwn(operation.payload.after as object, "occurrence"),
        false,
      );
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.insert_table_rows",
          area: "table",
          before: "",
          after: "Charlie|CFO",
        },
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  });

  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const tool = createDocumentInsertTableRowsTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docRef,
    runtime,
    mutations,
  });

  const result = await tool.execute(
    tool.parseInput({
      table: { headerCells: ["Name", "Role"], occurrence: 0 },
      after: { firstCellText: "Bob", occurrence: 0 },
      rows: [["Charlie", "CFO"]],
    }),
    ctx,
  );

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  if (result.status === "success") {
    assert.equal(result.document.versionId, "ver-1+1");
    assert.equal(result.baseVersionId, "ver-1");
  }
  assert.equal(seenPayloads.length, 1);
});
