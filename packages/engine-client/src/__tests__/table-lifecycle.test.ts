import assert from "node:assert/strict";
import { test } from "node:test";

import { Capabilities, type DocumentRef } from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import {
  createOpenSuiteEngineAdapter,
  mapCreateTableOperation,
  mapDeleteTableColumnOperation,
  mapDeleteTableOperation,
  mapDeleteTableRowOperation,
  mapRustCapabilitiesToRuntime,
} from "../opensuite-engine-adapter.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("mapCreateTableOperation preserves ordered matrix and placement", () => {
  const mapped = mapCreateTableOperation({
    type: "document.create_table",
    baseVersionId: "ver-1",
    payload: {
      rows: [
        ["Task", "Owner"],
        ["Prepare report", ""],
      ],
      placement: { kind: "before", handle: "b2" },
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    rows: [
      ["Task", "Owner"],
      ["Prepare report", ""],
    ],
    placement: { kind: "before", handle: "b2" },
    baseRevision: "ver-1",
  });
});

test("delete table/row/column map to native shapes", () => {
  const table = mapDeleteTableOperation({
    type: "document.delete_table",
    baseVersionId: "ver-1",
    payload: { table: { handle: "t0" } },
  });
  assert.equal(table.ok, true);
  if (table.ok) {
    assert.deepEqual(table.operation, {
      table: { handle: "t0" },
      baseRevision: "ver-1",
    });
  }

  const row = mapDeleteTableRowOperation({
    type: "document.delete_table_row",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      row: { handle: "r1" },
    },
  });
  assert.equal(row.ok, true);
  if (row.ok) {
    assert.deepEqual(row.operation, {
      table: { handle: "t0" },
      row: { handle: "r1" },
      baseRevision: "ver-1",
    });
  }

  const col = mapDeleteTableColumnOperation({
    type: "document.delete_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      columnHandle: "c2",
    },
  });
  assert.equal(col.ok, true);
  if (col.ok) {
    assert.deepEqual(col.operation, {
      table: { handle: "t0" },
      columnHandle: "c2",
      baseRevision: "ver-1",
    });
  }
});

test("create_table adapter calls binding once with verified bytes", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxCreateTable: async (_input, operation) => ({
      result: {
        ok: true,
        status: "ok",
        diagnostics: [],
        changes: [
          {
            kind: "create_table",
            before: "",
            after: operation.rows.map((r) => r.join("|")).join(";"),
          },
        ],
      },
      output: new Uint8Array([9, 9, 9]),
    }),
  });
  const loader = createMemoryArtifactLoader(
    new Map([["ver-1", new Uint8Array([1])]]),
  );
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: loader,
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.create_table",
    baseVersionId: "ver-1",
    payload: {
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
      placement: { kind: "end" },
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.artifactBytes, new Uint8Array([9, 9, 9]));
  assert.equal(binding.createTableCalls.length, 1);
  assert.deepEqual(binding.createTableCalls[0]?.operation, {
    rows: [
      ["A", "B"],
      ["1", "2"],
    ],
    placement: { kind: "end" },
    baseRevision: "ver-1",
  });
});

test("failed delete_table_row preserves LAST_TABLE_ROW diagnostic", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxDeleteTableRow: async () => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "PRECONDITION_FAILED",
            severity: "error",
            message: "last row",
            reasonCode: "LAST_TABLE_ROW",
            operation: "delete_table_row",
            targetHandle: "r0",
          },
        ],
        changes: [],
      },
    }),
  });
  const loader = createMemoryArtifactLoader(
    new Map([["ver-1", new Uint8Array([1])]]),
  );
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: loader,
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.delete_table_row",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      row: { handle: "r0" },
    },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.diagnostics[0]?.reasonCode, "LAST_TABLE_ROW");
  assert.equal(result.diagnostics[0]?.targetHandle, "r0");
  assert.equal(binding.deleteTableRowCalls.length, 1);
});

test("Rust table lifecycle caps synthesize document.mutate", () => {
  const caps = mapRustCapabilitiesToRuntime({
    ok: true,
    protocolVersion: 1,
    engineVersion: "test",
    formats: [
      {
        format: "docx",
        capabilities: [
          "inspect",
          "create_table",
          "delete_table",
          "delete_table_row",
          "delete_table_column",
        ],
      },
    ],
  });
  assert.ok(caps.ids.has(Capabilities.DocumentMutate));
  assert.ok(caps.ids.has("create_table"));
  assert.ok(caps.ids.has("delete_table_column"));
});
