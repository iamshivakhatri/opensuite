import assert from "node:assert/strict";
import { test } from "node:test";

import { Capabilities, type DocumentRef } from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import {
  createOpenSuiteEngineAdapter,
  mapRustCapabilitiesToRuntime,
  mapSetTableFormattingOperation,
} from "../opensuite-engine-adapter.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("mapSetTableFormattingOperation preserves N-API fields", () => {
  const mapped = mapSetTableFormattingOperation({
    type: "document.set_table_formatting",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      alignment: "center",
      borders: "grid",
      cellMarginTopTwips: 80,
      cellMarginRightTwips: 80,
      cellMarginBottomTwips: 80,
      cellMarginLeftTwips: 80,
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    table: { handle: "t0" },
    alignment: "center",
    borders: "grid",
    cellMarginTopTwips: 80,
    cellMarginRightTwips: 80,
    cellMarginBottomTwips: 80,
    cellMarginLeftTwips: 80,
    baseRevision: "ver-1",
  });
});

test("set_table_formatting adapter calls binding once with verified bytes", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxSetTableFormatting: async (_input, operation) => ({
      result: {
        ok: true,
        status: "ok",
        diagnostics: [],
        changes: [
          {
            kind: "set_table_formatting",
            before: "",
            after: operation.alignment ?? "",
          },
        ],
      },
      output: new Uint8Array([7, 7, 7]),
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
    type: "document.set_table_formatting",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      alignment: "center",
      borders: "none",
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.artifactBytes, new Uint8Array([7, 7, 7]));
  assert.equal(binding.setTableFormattingCalls.length, 1);
  assert.deepEqual(binding.setTableFormattingCalls[0]?.operation, {
    table: { handle: "t0" },
    alignment: "center",
    borders: "none",
    baseRevision: "ver-1",
  });
});

test("failed set_table_formatting preserves structured diagnostic", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxSetTableFormatting: async () => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "UNSUPPORTED_OPERATION",
            severity: "error",
            message: "not rectangular",
            reasonCode: "MERGED_CELLS",
            operation: "set_table_formatting",
            targetHandle: "t0",
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
    type: "document.set_table_formatting",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      borders: "none",
    },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.diagnostics[0]?.reasonCode, "MERGED_CELLS");
  assert.equal(result.diagnostics[0]?.operation, "set_table_formatting");
  assert.equal(result.diagnostics[0]?.targetHandle, "t0");
});

test("set_table_formatting capability maps to DocumentMutate", () => {
  const caps = mapRustCapabilitiesToRuntime({
    ok: true,
    protocolVersion: 1,
    engineVersion: "test",
    formats: [
      {
        format: "docx",
        capabilities: ["inspect", "set_table_formatting"],
      },
    ],
  });
  assert.ok(caps.ids.has(Capabilities.DocumentMutate));
  assert.ok(caps.ids.has("set_table_formatting"));
});
