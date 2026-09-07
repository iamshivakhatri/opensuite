import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type {
  DocumentAffordance,
  DocumentRef,
  InspectedTable,
  InspectedTableCell,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-afford",
  versionId: "ver-1",
  format: "docx",
};

test("adapter maps engine affordances without recomputing editability", async () => {
  const binding = createFakeDocxEngineBinding({
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
            affordances: [
              { capability: "insert_table_rows", supported: true },
              {
                capability: "insert_table_column",
                supported: false,
                reason: "INVALID_TABLE_GRID",
              },
            ],
            columns: [
              { occurrence: 0, handle: "t0:c0", text: "Name" },
              { occurrence: 1, handle: "t0:c1", text: "Year" },
            ],
            rows: [
              {
                handle: "t0:r0",
                cells: ["Name", "Year"],
                cellHandles: ["t0:r0:c0", "t0:r0:c1"],
                cellAffordances: [
                  [
                    {
                      capability: "set_table_cell_text",
                      supported: true,
                    },
                    {
                      capability: "set_table_cells_text",
                      supported: true,
                    },
                  ],
                  [
                    {
                      capability: "set_table_cell_text",
                      supported: false,
                      reason: "MULTIPLE_PARAGRAPHS",
                    },
                    {
                      capability: "set_table_cells_text",
                      supported: false,
                      reason: "MULTIPLE_PARAGRAPHS",
                    },
                  ],
                ],
              },
              {
                handle: "t0:r1",
                cells: ["OpenSuite", "2026"],
                cellHandles: ["t0:r1:c0", "t0:r1:c1"],
                cellAffordances: [
                  [
                    {
                      capability: "set_table_cells_text",
                      supported: true,
                    },
                  ],
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
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": new Uint8Array([1, 2, 3]),
    }),
    binding,
  });

  const result = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(result.status, "success");
  if (result.status !== "success" || result.payload.format !== "docx") {
    assert.fail("expected docx tables");
  }

  const table = result.payload.tables?.[0];
  assert.ok(table);
  assert.deepEqual(table.affordances, [
    { capability: "insert_table_rows", supported: true },
    {
      capability: "insert_table_column",
      supported: false,
      reason: "INVALID_TABLE_GRID",
    },
  ]);

  const name = table.rows?.[0]?.cells?.[0];
  const year = table.rows?.[0]?.cells?.[1];
  const opensuite = table.rows?.[1]?.cells?.[0];
  const y2026 = table.rows?.[1]?.cells?.[1];
  assert.equal(name?.text, "Name");
  assert.equal(name?.affordances?.[1]?.supported, true);
  assert.equal(year?.text, "Year");
  assert.equal(year?.affordances?.[0]?.reason, "MULTIPLE_PARAGRAPHS");
  assert.equal(opensuite?.affordances?.[0]?.supported, true);
  assert.equal(y2026?.affordances?.[0]?.supported, false);
  assert.equal(y2026?.affordances?.[0]?.reason, "MULTIPLE_PARAGRAPHS");
  assertNoEngineSourceIdentities(result);
});

test("adapter omits affordances when engine does not provide them", async () => {
  const binding = createFakeDocxEngineBinding({
    inspectDocx: () => ({
      ok: true,
      focus: "tables",
      tables: {
        page: { total: 1, offset: 0, returned: 1, hasMore: false },
        items: [
          {
            occurrence: 0,
            handle: "t0",
            rowCount: 1,
            isRectangular: true,
            columns: [{ occurrence: 0, handle: "t0:c0", text: "A" }],
            rows: [
              {
                handle: "t0:r0",
                cells: ["A"],
                cellHandles: ["t0:r0:c0"],
              },
            ],
          },
        ],
      },
      diagnostics: [],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": new Uint8Array([1]),
    }),
    binding,
  });

  const result = await runtime.inspect(docRef, { focus: { kind: "tables" } });
  assert.equal(result.status, "success");
  if (result.status === "success" && result.payload.format === "docx") {
    assert.equal(result.payload.tables?.[0]?.affordances, undefined);
    assert.equal(
      result.payload.tables?.[0]?.rows?.[0]?.cells?.[0]?.affordances,
      undefined,
    );
  }
});

test("native: google-docs fixture has mixed cell affordances", async (t) => {
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

  const result = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(result.status, "success");
  if (result.status !== "success" || result.payload.format !== "docx") {
    assert.fail("expected docx tables");
  }

  const table: InspectedTable | undefined = result.payload.tables?.[0];
  assert.ok(table);
  assert.ok(table.affordances && table.affordances.length >= 1);
  assert.ok(table.affordances.every((a) => a.supported === true));

  const expectations: Array<{
    row: number;
    col: number;
    text: string;
    supported: boolean;
  }> = [
    { row: 0, col: 0, text: "Name", supported: true },
    { row: 0, col: 1, text: "Year", supported: false },
    { row: 1, col: 0, text: "OpenSuite", supported: true },
    { row: 1, col: 1, text: "2026", supported: false },
  ];

  for (const item of expectations) {
    const inspectedCell: InspectedTableCell | undefined =
      table.rows?.[item.row]?.cells?.[item.col];
    assert.ok(inspectedCell, `missing cell ${item.row},${item.col}`);
    // Fixture text may include Google Docs whitespace; match by trimmed label.
    assert.equal(inspectedCell.text.trim(), item.text);
    const affordances = inspectedCell.affordances;
    assert.ok(affordances && affordances.length > 0);
    assert.ok(
      affordances.every((a) => a.supported === item.supported),
      `${item.text} affordances should be supported=${item.supported}`,
    );
    if (!item.supported) {
      assert.ok(
        affordances.every((a) => a.reason === "MULTIPLE_PARAGRAPHS"),
      );
    }
  }

  // Global capability vs target affordance: mutation id present on cells,
  // some unsupported — proves the two layers stay distinct.
  const year: InspectedTableCell | undefined = table.rows?.[0]?.cells?.[1];
  assert.ok(
    year?.affordances?.some(
      (a: DocumentAffordance) =>
        a.capability === "set_table_cells_text" && a.supported === false,
    ),
  );
  assertNoEngineSourceIdentities(result);
});
