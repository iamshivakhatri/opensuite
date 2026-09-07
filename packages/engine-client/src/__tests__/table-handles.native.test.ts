import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentSetTableCellsTextTool,
  createInMemoryDocumentMutationExecutor,
  createFakeToolExecutionContext,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import {
  buildExecutiveAccessTableDocx,
  buildNameRoleTableDocx,
} from "../__fixtures__/minimal-docx.js";

async function loadBinding(t: { skip: (msg?: string) => void }) {
  try {
    return await createNapiDocxEngineBinding();
  } catch (error) {
    t.skip(
      `Native @opensuite/engine binding unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

test("native: blank trailing row filled atomically by cell handles", async (t) => {
  const binding = await loadBinding(t);
  if (!binding) return;

  const v1Bytes = buildExecutiveAccessTableDocx();
  const v1Ref: DocumentRef = {
    documentId: "exec-access",
    versionId: "ver-1",
    format: "docx",
  };
  const versions = new Map<string, Uint8Array>([["ver-1", v1Bytes]]);
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: {
      async loadExactVersionBytes(document) {
        const bytes = versions.get(document.versionId);
        if (!bytes) throw new Error(`missing ${document.versionId}`);
        return bytes;
      },
    },
    binding,
  });

  const inspected = await runtime.inspect(v1Ref, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    return;
  }
  assertNoEngineSourceIdentities(inspected);

  const table = inspected.payload.tables?.[0];
  assert.ok(table);
  assert.equal(table.handle, "t0");
  const lastRow = table.rows?.[table.rows.length - 1];
  assert.ok(lastRow?.handle);
  assert.equal(lastRow.cells.length, 2);
  assert.equal(lastRow.cells[0]!.text, "");
  assert.equal(lastRow.cells[1]!.text, "");
  assert.ok(lastRow.cells[0]!.handle);
  assert.ok(lastRow.cells[1]!.handle);

  let executeCount = 0;
  const originalExecute = runtime.execute!.bind(runtime);
  runtime.execute = async (document, operation, options) => {
    executeCount += 1;
    const result = await originalExecute(document, operation, options);
    if (result.status === "success" && result.artifactBytes) {
      versions.set("ver-1+1", result.artifactBytes);
    }
    return result;
  };

  const tool = createDocumentSetTableCellsTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: v1Ref,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  });

  const result = await tool.execute(
    {
      table: { handle: table.handle },
      updates: [
        {
          target: { handle: lastRow.cells[0]!.handle },
          expectedCurrentText: "",
          replacement: "Guest Panelist",
        },
        {
          target: { handle: lastRow.cells[1]!.handle },
          expectedCurrentText: "",
          replacement: "Invited — selected meetings",
        },
      ],
    },
    ctx,
  );

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  assert.equal(result.document.versionId, "ver-1+1");
  assert.equal(result.baseVersionId, "ver-1");
  assert.ok(versions.has("ver-1+1"));

  const v1Still = await runtime.inspect(v1Ref, {
    focus: { kind: "tables" },
  });
  assert.equal(v1Still.status, "success");
  if (v1Still.status === "success" && v1Still.payload.format === "docx") {
    const trailing = v1Still.payload.tables?.[0]?.cells?.at(-1);
    assert.deepEqual(trailing, ["", ""]);
  }

  const v2Ref: DocumentRef = {
    ...v1Ref,
    versionId: "ver-1+1",
  };
  const after = await runtime.inspect(v2Ref, { focus: { kind: "tables" } });
  assert.equal(after.status, "success");
  if (after.status === "success" && after.payload.format === "docx") {
    const trailing = after.payload.tables?.[0]?.cells?.at(-1);
    assert.deepEqual(trailing, [
      "Guest Panelist",
      "Invited — selected meetings",
    ]);
  }
});

test("native: stale cell handle after version advance fails without new version", async (t) => {
  const binding = await loadBinding(t);
  if (!binding) return;

  const v1Bytes = buildExecutiveAccessTableDocx();
  const v1Ref: DocumentRef = {
    documentId: "stale-handle",
    versionId: "ver-1",
    format: "docx",
  };

  const runtimeV1 = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": v1Bytes }),
    binding,
  });
  const inspected = await runtimeV1.inspect(v1Ref, {
    focus: { kind: "tables" },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    return;
  }
  const table = inspected.payload.tables?.[0];
  const lastRow = table?.rows?.at(-1);
  assert.ok(table && lastRow);

  const mutated = await runtimeV1.execute!(v1Ref, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: table.handle },
      updates: [
        {
          target: { handle: lastRow.cells[0]!.handle },
          expectedCurrentText: "",
          replacement: "Guest Panelist",
        },
        {
          target: { handle: lastRow.cells[1]!.handle },
          expectedCurrentText: "",
          replacement: "Invited — selected meetings",
        },
      ],
    },
  });
  assert.equal(mutated.status, "success");
  if (mutated.status !== "success") return;

  const runtimeV2 = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-2": mutated.artifactBytes!,
    }),
    binding,
  });
  const stale = await runtimeV2.execute!(
    { ...v1Ref, versionId: "ver-2" },
    {
      type: "document.set_table_cells_text",
      baseVersionId: "ver-2",
      payload: {
        table: { handle: table.handle },
        updates: [
          {
            target: { handle: lastRow.cells[0]!.handle },
            expectedCurrentText: "",
            replacement: "Should not apply",
          },
        ],
      },
    },
  );
  assert.equal(stale.status, "error");
  if (stale.status === "error") {
    assert.equal(stale.code, "PRECONDITION_FAILED");
    assert.equal(stale.diagnostics[0]?.code, "PRECONDITION_FAILED");
  }
});

test("native: semantic cell targeting remains compatible", async (t) => {
  const binding = await loadBinding(t);
  if (!binding) return;

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildExecutiveAccessTableDocx(),
    }),
    binding,
  });
  const result = await runtime.execute!(
    {
      documentId: "semantic",
      versionId: "ver-1",
      format: "docx",
    },
    {
      type: "document.set_table_cells_text",
      baseVersionId: "ver-1",
      payload: {
        table: {
          headerCells: ["Executive Role", "Meeting Access Level"],
        },
        updates: [
          {
            rowLabel: "CFO",
            columnHeader: "Meeting Access Level",
            expectedCurrentText: "Full access",
            replacement: "All meetings",
          },
        ],
      },
    },
  );
  assert.equal(result.status, "success");
  if (result.status !== "success") return;

  const after = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-2": result.artifactBytes!,
    }),
    binding,
  });
  const inspected = await after.inspect(
    { documentId: "semantic", versionId: "ver-2", format: "docx" },
    { focus: { kind: "tables" } },
  );
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "docx") {
    assert.equal(inspected.payload.tables?.[0]?.cells?.[1]?.[1], "All meetings");
  }
});

test("native: row handle insert and column handle insert", async (t) => {
  const binding = await loadBinding(t);
  if (!binding) return;

  const inputBytes = buildNameRoleTableDocx({ withGrid: true });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": inputBytes }),
    binding,
  });
  const docRef: DocumentRef = {
    documentId: "row-col-handle",
    versionId: "ver-1",
    format: "docx",
  };

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "tables" },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    return;
  }
  const table = inspected.payload.tables?.[0];
  assert.ok(table?.handle);
  const bobRow = table.rows?.find((row) => row.cells[0]?.text === "Bob");
  const roleColumn = table.columns?.find((column) => column.text === "Role");
  assert.ok(bobRow?.handle);
  assert.ok(roleColumn?.handle);

  const insertedRows = await runtime.execute!(docRef, {
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: table.handle },
      after: { handle: bobRow.handle },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(insertedRows.status, "success");
  if (insertedRows.status !== "success") return;

  const afterRowsRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-2": insertedRows.artifactBytes!,
    }),
    binding,
  });
  const afterRowsInspect = await afterRowsRuntime.inspect(
    { ...docRef, versionId: "ver-2" },
    { focus: { kind: "tables" } },
  );
  assert.equal(afterRowsInspect.status, "success");
  if (
    afterRowsInspect.status === "success" &&
    afterRowsInspect.payload.format === "docx"
  ) {
    assert.deepEqual(afterRowsInspect.payload.tables?.[0]?.cells?.[3], [
      "Charlie",
      "CFO",
    ]);
  }

  // Column insert: pass headerCells (engine verify path) + column handle.
  const insertedColumn = await runtime.execute!(docRef, {
    type: "document.insert_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], handle: table.handle },
      afterColumnHandle: roleColumn.handle,
      header: "Location",
      cells: ["New York", "Seattle"],
    },
  });
  assert.equal(insertedColumn.status, "success");
  if (insertedColumn.status !== "success") return;

  const finalRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-3": insertedColumn.artifactBytes!,
    }),
    binding,
  });
  const finalInspect = await finalRuntime.inspect(
    { ...docRef, versionId: "ver-3" },
    { focus: { kind: "tables" } },
  );
  assert.equal(finalInspect.status, "success");
  if (finalInspect.status === "success" && finalInspect.payload.format === "docx") {
    assert.deepEqual(finalInspect.payload.tables?.[0]?.cells?.[0], [
      "Name",
      "Role",
      "Location",
    ]);
    assert.deepEqual(finalInspect.payload.tables?.[0]?.cells?.[1], [
      "Alice",
      "CEO",
      "New York",
    ]);
  }
});
