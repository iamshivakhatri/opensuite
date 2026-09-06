import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  Capabilities,
  hasCapability,
  listCapabilities,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx, buildNameRoleTableDocx } from "../__fixtures__/minimal-docx.js";

const SMOKE_OUTPUT = "/private/tmp/opensuite-app-engine-adapter-output.docx";

test("smoke: capabilities → find → inspect → replace → find/inspect output", async (t) => {
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

  const inputBytes = buildMinimalDocx(["old text", "Date:", "Date:"]);
  const docRef: DocumentRef = {
    documentId: "smoke-doc",
    versionId: "smoke-ver-1",
    format: "docx",
  };

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-1": inputBytes,
    }),
    binding,
  });

  const caps = await runtime.capabilities(docRef);
  const ids = listCapabilities(caps);
  assert.ok(ids.includes("find_text"));
  assert.ok(ids.includes("inspect_context") || ids.includes("inspect"));
  assert.ok(ids.includes("replace_text"));
  assert.ok(hasCapability(caps, Capabilities.DocumentFind));
  assert.ok(hasCapability(caps, Capabilities.DocumentInspect));
  assert.ok(hasCapability(caps, Capabilities.DocumentMutate));

  const found = await runtime.find!(docRef, {
    query: "old text",
    mode: "text",
  });
  assert.equal(found.status, "success");
  if (found.status === "success") {
    assert.ok(found.matches.length >= 1);
    assertNoEngineSourceIdentities(found);
  }

  const overview = await runtime.inspect(docRef, {
    focus: { kind: "overview" },
  });
  assert.equal(overview.status, "success");
  if (overview.status === "success" && overview.payload.format === "docx") {
    assert.ok((overview.payload.overview?.paragraphCount ?? 0) >= 1);
    assertNoEngineSourceIdentities(overview);
  }

  const headings = await runtime.inspect(docRef, {
    focus: { kind: "headings", offset: 0, limit: 10 },
  });
  assert.equal(headings.status, "success");
  if (headings.status === "success" && headings.payload.format === "docx") {
    assert.ok(headings.payload.page);
  }

  const paragraphs = await runtime.inspect(docRef, {
    focus: { kind: "paragraphs", offset: 0, limit: 10 },
  });
  assert.equal(paragraphs.status, "success");
  if (paragraphs.status === "success" && paragraphs.payload.format === "docx") {
    assert.ok((paragraphs.payload.paragraphs?.length ?? 0) >= 1);
  }

  const tables = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(tables.status, "success");
  if (tables.status === "success" && tables.payload.format === "docx") {
    assert.ok(tables.payload.page);
    assertNoEngineSourceIdentities(tables);
  }

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "context", text: "old text", before: 1, after: 1 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "docx") {
    assert.equal(inspected.payload.context?.container?.text, "old text");
    assertNoEngineSourceIdentities(inspected);
  }

  const slides = await runtime.inspect(docRef, {
    focus: { kind: "slides" },
  });
  assert.equal(slides.status, "error");
  if (slides.status === "error") {
    assert.equal(slides.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }

  const success = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: {
      find: "old text",
      replace: "OpenSuite app adapter replacement",
    },
  });

  assert.equal(success.status, "success");
  if (success.status !== "success") return;
  assert.ok(success.artifactBytes);
  assertNoEngineSourceIdentities(success);
  writeFileSync(SMOKE_OUTPUT, success.artifactBytes!);

  const outputRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-out": success.artifactBytes!,
    }),
    binding,
  });
  const outRef: DocumentRef = {
    documentId: "smoke-doc",
    versionId: "smoke-ver-out",
    format: "docx",
  };

  const foundOut = await outputRuntime.find!(outRef, {
    query: "OpenSuite app adapter replacement",
    mode: "text",
  });
  assert.equal(foundOut.status, "success");
  if (foundOut.status === "success") {
    assert.ok(foundOut.matches.length >= 1);
  }

  const inspectOut = await outputRuntime.inspect(outRef, {
    focus: {
      kind: "context",
      text: "OpenSuite app adapter replacement",
    },
  });
  assert.equal(inspectOut.status, "success");
  if (inspectOut.status === "success" && inspectOut.payload.format === "docx") {
    assert.equal(
      inspectOut.payload.context?.container?.text,
      "OpenSuite app adapter replacement",
    );
  }

  const paragraphsOut = await outputRuntime.inspect(outRef, {
    focus: { kind: "paragraphs", offset: 0, limit: 20 },
  });
  assert.equal(paragraphsOut.status, "success");
  if (
    paragraphsOut.status === "success" &&
    paragraphsOut.payload.format === "docx"
  ) {
    assert.ok(
      paragraphsOut.payload.paragraphs?.some(
        (p) => p.text === "OpenSuite app adapter replacement",
      ),
    );
  }

  // Original version bytes still searchable on the original runtime/loader.
  const stillOriginal = await runtime.find!(docRef, {
    query: "old text",
    mode: "text",
  });
  assert.equal(stillOriginal.status, "success");

  const missing = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "not present", replace: "x" },
  });
  assert.equal(missing.status, "error");
  if (missing.status === "error") {
    assert.equal(missing.code, "TARGET_NOT_FOUND");
  }

  const ambiguous = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "Date:", replace: "x" },
  });
  assert.equal(ambiguous.status, "error");
  if (ambiguous.status === "error") {
    assert.equal(ambiguous.code, "TARGET_AMBIGUOUS");
  }

  const invalidRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-1": Buffer.from("not a DOCX"),
    }),
    binding,
  });
  const invalidResult = await invalidRuntime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "anything", replace: "x" },
  });
  assert.equal(invalidResult.status, "error");
  if (invalidResult.status === "error") {
    assert.equal(invalidResult.code, "DOCUMENT_INVALID");
  }
});

test("smoke: table cells/rows/column mutations against native engine", async (t) => {
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

  const caps = mapRustLike(binding);
  assert.ok(caps.includes("set_table_cells_text"));
  assert.ok(caps.includes("insert_table_rows"));
  assert.ok(caps.includes("insert_table_column"));

  const inputBytes = buildNameRoleTableDocx({ withGrid: true });
  const docRef: DocumentRef = {
    documentId: "smoke-table",
    versionId: "ver-1",
    format: "docx",
  };
  let runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": inputBytes }),
    binding,
  });

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    return;
  }
  assert.equal(inspected.payload.tables?.[0]?.cells?.[1]?.[0], "Alice");

  const rows = await runtime.execute!(docRef, {
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      after: { firstCellText: "Bob" },
      rows: [
        ["Charlie", "CFO"],
        ["David", "COO"],
      ],
    },
  });
  assert.equal(rows.status, "success");
  if (rows.status !== "success") return;

  runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-2": rows.artifactBytes! }),
    binding,
  });
  const ref2: DocumentRef = {
    documentId: "smoke-table",
    versionId: "ver-2",
    format: "docx",
  };
  const afterRows = await runtime.inspect(ref2, {
    focus: { kind: "tables" },
  });
  assert.equal(afterRows.status, "success");
  if (afterRows.status === "success" && afterRows.payload.format === "docx") {
    const cells = afterRows.payload.tables?.[0]?.cells ?? [];
    assert.deepEqual(cells[3], ["Charlie", "CFO"]);
    assert.deepEqual(cells[4], ["David", "COO"]);
  }

  const cells = await runtime.execute!(ref2, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-2",
    payload: {
      table: { headerCells: ["Name", "Role"] },
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
  });
  assert.equal(cells.status, "success");
  if (cells.status !== "success") return;

  runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-3": cells.artifactBytes!,
    }),
    binding,
  });
  const ref3: DocumentRef = {
    documentId: "smoke-table",
    versionId: "ver-3",
    format: "docx",
  };

  const column = await runtime.execute!(ref3, {
    type: "document.insert_table_column",
    baseVersionId: "ver-3",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["New York", "Seattle", "Austin", "Remote"],
    },
  });
  assert.equal(column.status, "success");
  if (column.status !== "success") return;
  writeFileSync(
    "/private/tmp/opensuite-app-engine-table-mutations.docx",
    column.artifactBytes!,
  );

  runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-4": column.artifactBytes!,
    }),
    binding,
  });
  const finalInspect = await runtime.inspect(
    {
      documentId: "smoke-table",
      versionId: "ver-4",
      format: "docx",
    },
    { focus: { kind: "tables" } },
  );
  assert.equal(finalInspect.status, "success");
  if (
    finalInspect.status === "success" &&
    finalInspect.payload.format === "docx"
  ) {
    const table = finalInspect.payload.tables?.[0];
    assert.deepEqual(table?.cells?.[0], ["Name", "Role", "Location"]);
    assert.deepEqual(table?.cells?.[1], ["Alice", "Founder & CEO", "New York"]);
    assert.equal(table?.isRectangular, true);
  }

  // Precondition failure leaves no artifact
  const bad = await createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": inputBytes }),
    binding,
  }).execute!(docRef, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      updates: [
        {
          rowLabel: "Alice",
          columnHeader: "Role",
          expectedCurrentText: "WRONG",
          replacement: "X",
        },
      ],
    },
  });
  assert.equal(bad.status, "error");
});

function mapRustLike(binding: Awaited<ReturnType<typeof createNapiDocxEngineBinding>>) {
  return binding.getDocxCapabilities().formats.find((f) => f.format === "docx")
    ?.capabilities ?? [];
}
