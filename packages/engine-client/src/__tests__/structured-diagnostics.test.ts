import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { DocumentRef, InspectedTableCell } from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-diag",
  versionId: "ver-1",
  format: "docx",
};

test("native diagnostic fields reach runtime unchanged", async () => {
  const message =
    "set_table_cells_text requires one ordinary paragraph with direct runs";
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxSetTableCellsText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              reasonCode: "MULTIPLE_PARAGRAPHS",
              operation: "set_table_cells_text",
              targetHandle: "t0:r1:c1",
              message,
            },
          ],
          changes: [],
        },
      }),
    }),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      updates: [
        {
          target: { handle: "t0:r1:c1" },
          expectedCurrentText: "2026",
          replacement: "2027",
        },
      ],
    },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  const diagnostic = result.diagnostics[0]!;
  assert.equal(diagnostic.code, "UNSUPPORTED_OPERATION");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.reasonCode, "MULTIPLE_PARAGRAPHS");
  assert.equal(diagnostic.operation, "set_table_cells_text");
  assert.equal(diagnostic.targetHandle, "t0:r1:c1");
  assert.equal(diagnostic.message, message);
  assertNoEngineSourceIdentities(result);
});

test("minimal diagnostics without structured fields remain valid", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "TARGET_NOT_FOUND",
              severity: "error",
              message: "missing",
            },
          ],
          changes: [],
        },
      }),
    }),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "missing", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  const diagnostic = result.diagnostics[0]!;
  assert.equal(diagnostic.code, "TARGET_NOT_FOUND");
  assert.equal(diagnostic.reasonCode, undefined);
  assert.equal(diagnostic.operation, undefined);
  assert.equal(diagnostic.targetHandle, undefined);
});

test("affordance reason and mutation reasonCode stay identical through adapter", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding({
      inspectDocx: () => ({
        ok: true,
        focus: "tables",
        tables: {
          page: { total: 1, offset: 0, returned: 1, hasMore: false },
          items: [
            {
              occurrence: 0,
              handle: "t0",
              rowCount: 2,
              isRectangular: true,
              columns: [{ occurrence: 0, handle: "t0:c1", text: "Year" }],
              rows: [
                {
                  handle: "t0:r1",
                  cells: ["2026"],
                  cellHandles: ["t0:r1:c1"],
                  cellAffordances: [
                    [
                      {
                        capability: "set_table_cells_text",
                        supported: false,
                        reason: "MULTIPLE_PARAGRAPHS",
                      },
                    ],
                  ],
                },
              ],
            },
          ],
        },
        diagnostics: [],
      }),
      executeDocxSetTableCellsText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              reasonCode: "MULTIPLE_PARAGRAPHS",
              operation: "set_table_cells_text",
              targetHandle: "t0:r1:c1",
              message: "multi-paragraph cell",
            },
          ],
          changes: [],
        },
      }),
    }),
  });

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    assert.fail("expected tables");
  }
  const cell: InspectedTableCell | undefined =
    inspected.payload.tables?.[0]?.rows?.[0]?.cells?.[0];
  assert.equal(cell?.affordances?.[0]?.reason, "MULTIPLE_PARAGRAPHS");

  const failed = await runtime.execute!(docRef, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      updates: [
        {
          target: { handle: "t0:r1:c1" },
          expectedCurrentText: "2026",
          replacement: "2027",
        },
      ],
    },
  });
  assert.equal(failed.status, "error");
  if (failed.status !== "error") return;
  assert.equal(failed.diagnostics[0]?.reasonCode, "MULTIPLE_PARAGRAPHS");
  assert.equal(
    failed.diagnostics[0]?.reasonCode,
    cell?.affordances?.[0]?.reason,
  );
});

test("mapDiagnostic does not derive reasonCode from message", () => {
  const adapterSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/opensuite-engine-adapter.ts",
    ),
    "utf8",
  );
  assert.match(adapterSource, /function mapDiagnostic/);
  assert.doesNotMatch(adapterSource, /message\.includes\s*\(/);
  assert.doesNotMatch(adapterSource, /\/multiple\s*paragraphs\/i/);
  assert.doesNotMatch(
    adapterSource,
    /reasonCode:\s*diagnostic\.message/,
  );
});

test("native: google-docs fixture mutation emits structured diagnostic", async (t) => {
  let binding;
  try {
    binding = await createNapiDocxEngineBinding();
  } catch (error) {
    t.skip(
      `Native @opensuite/engine binding unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../opensuite-engine/tests/fixtures/google-docs-table.docx",
  );
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(fixturePath);
  } catch {
    t.skip(`Google Docs fixture not found at ${fixturePath}`);
    return;
  }

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": bytes }),
    binding,
  });

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    assert.fail("expected docx tables");
  }

  const yearCell = inspected.payload.tables?.[0]?.rows?.[0]?.cells?.[1];
  assert.ok(yearCell?.handle);
  assert.equal(
    yearCell?.affordances?.find((a) => a.capability === "set_table_cells_text")
      ?.reason,
    "MULTIPLE_PARAGRAPHS",
  );

  const tableHandle = inspected.payload.tables?.[0]?.handle;
  assert.ok(tableHandle);

  const failed = await runtime.execute!(docRef, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: tableHandle },
      updates: [
        {
          target: { handle: yearCell.handle },
          expectedCurrentText: yearCell.text,
          replacement: "2027",
        },
      ],
    },
  });

  assert.equal(failed.status, "error");
  if (failed.status !== "error") return;
  const diagnostic = failed.diagnostics[0]!;
  assert.equal(diagnostic.code, "UNSUPPORTED_OPERATION");
  assert.equal(diagnostic.reasonCode, "MULTIPLE_PARAGRAPHS");
  assert.equal(diagnostic.operation, "set_table_cells_text");
  assert.equal(diagnostic.targetHandle, yearCell.handle);
  assert.ok(diagnostic.message.length > 0);
  assertNoEngineSourceIdentities(failed);
});
