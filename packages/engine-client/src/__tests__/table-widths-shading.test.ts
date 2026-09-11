import assert from "node:assert/strict";
import { test } from "node:test";

import type { DocumentRef } from "@opensuite/agent-core";
import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createOpenSuiteEngineAdapter } from "../opensuite-engine-adapter.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const document: DocumentRef = { documentId: "doc", versionId: "v1", format: "docx" };
const loader = () => createMemoryArtifactLoader(new Map([["v1", new Uint8Array([1])]]));
const success = (kind: string) => ({ result: { ok: true, status: "ok", diagnostics: [], changes: [{ kind, before: "", after: "" }] }, output: new Uint8Array([2]) });

test("table widths and shading reach the binding with verified bytes", async () => {
  let widths: unknown;
  let shading: unknown;
  const runtime = createOpenSuiteEngineAdapter({ artifactLoader: loader(), binding: createFakeDocxEngineBinding({
    executeDocxSetTableColumnWidths: async (_bytes, operation) => { widths = operation; return success("set_table_column_widths"); },
    executeDocxSetTableCellShading: async (_bytes, operation) => { shading = operation; return success("set_table_cell_shading"); },
  }) });
  const widthResult = await runtime.execute!(document, { type: "document.set_table_column_widths", baseVersionId: "v1", payload: { table: { handle: "t0" }, widthsTwips: [1440, 2880] } });
  const shadingResult = await runtime.execute!(document, { type: "document.set_table_cell_shading", baseVersionId: "v1", payload: { table: { handle: "t0" }, updates: [{ target: { handle: "c0" }, fill: "aabbcc" }, { target: { handle: "c1" } }] } });
  assert.equal(widthResult.status, "success"); assert.equal(shadingResult.status, "success");
  assert.deepEqual(widths, { table: { handle: "t0" }, widthsTwips: [1440, 2880], baseRevision: "v1" });
  assert.deepEqual(shading, { table: { handle: "t0" }, updates: [{ target: { handle: "c0" }, fill: "AABBCC" }, { target: { handle: "c1" }}], baseRevision: "v1" });
});

test("invalid shading is rejected before the binding", async () => {
  const runtime = createOpenSuiteEngineAdapter({ artifactLoader: loader(), binding: createFakeDocxEngineBinding({}) });
  const result = await runtime.execute!(document, { type: "document.set_table_cell_shading", baseVersionId: "v1", payload: { table: { handle: "t0" }, updates: [{ target: { handle: "c0" }, fill: "red" }] } });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "VALIDATION_FAILED");
});
