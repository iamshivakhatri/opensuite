import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Capabilities,
  createDocumentInspectTool,
  createDocumentReplaceTextTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  hasCapability,
  listCapabilities,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
  mapInsertTableColumnOperation,
  mapInsertTableRowsOperation,
  mapReplaceTextOperation,
  mapRustCapabilitiesToRuntime,
  mapSetTableCellsTextOperation,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("maps document.replace_text payload to engine ReplaceText DTO", () => {
  const mapped = mapReplaceTextOperation({
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: {
      find: "old text",
      replace: "new text",
      occurrence: 1,
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    target: { text: "old text", occurrence: 1 },
    expectedCurrentText: "old text",
    replacement: "new text",
    baseRevision: "ver-1",
  });
});

test("capabilities come from binding / Rust, not a hardcoded duplicate list", async () => {
  const binding = createFakeDocxEngineBinding({
    getDocxCapabilities: () => ({
      ok: true,
      protocolVersion: 1,
      engineVersion: "9.9.9",
      formats: [
        {
          format: "docx",
          capabilities: [
            "find_text",
            "inspect_context",
            "replace_text",
            "set_table_cell_text",
          ],
        },
      ],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": buildMinimalDocx(["x"]) }),
    binding,
  });

  const caps = await runtime.capabilities(docRef);
  const ids = listCapabilities(caps);
  assert.ok(ids.includes("find_text"));
  assert.ok(ids.includes("inspect_context"));
  assert.ok(ids.includes("replace_text"));
  assert.ok(ids.includes("set_table_cell_text"));
  assert.ok(hasCapability(caps, Capabilities.DocumentFind));
  assert.ok(hasCapability(caps, Capabilities.DocumentInspect));
  assert.ok(hasCapability(caps, Capabilities.DocumentMutate));

  const mapped = mapRustCapabilitiesToRuntime(binding.getDocxCapabilities());
  assert.deepEqual(listCapabilities(caps), listCapabilities(mapped));
});

test("adapter success: exact bytes reach binding and verified artifact returns", async () => {
  const inputBytes = buildMinimalDocx(["old text"]);
  const outputBytes = buildMinimalDocx(["OpenSuite replacement"]);
  const binding = createFakeDocxEngineBinding({
    executeDocxReplaceText: () => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [
          {
            kind: "text_replaced",
            before: "old text",
            after: "OpenSuite replacement",
          },
        ],
      },
      output: outputBytes,
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": inputBytes,
    }),
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "old text", replace: "OpenSuite replacement" },
  });

  assert.equal(result.status, "success");
  assert.equal(binding.replaceCalls.length, 1);
  assert.deepEqual(
    Buffer.from(binding.replaceCalls[0]!.input),
    Buffer.from(inputBytes),
  );
  if (result.status === "success") {
    assert.ok(result.artifactBytes);
    assert.deepEqual(
      Buffer.from(result.artifactBytes!),
      Buffer.from(outputBytes),
    );
    assertNoEngineSourceIdentities(result);
  }
});

test("find loads exact version bytes and maps matches", async () => {
  const v1 = buildMinimalDocx(["hello Date:"]);
  const v2 = buildMinimalDocx(["other"]);
  const binding = createFakeDocxEngineBinding({
    findDocxText: (input, request) => {
      assert.deepEqual(Buffer.from(input), v1);
      assert.equal(request.text, "Date:");
      return {
        ok: true,
        query: "Date:",
        matchCount: 2,
        matches: [
          {
            occurrence: 1,
            text: "Date:",
            before: "hello ",
            after: "",
            container: "paragraph",
          },
          {
            occurrence: 2,
            text: "Date:",
            before: "",
            after: " end",
            container: "paragraph",
          },
        ],
        diagnostics: [],
      };
    },
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": v1,
      "ver-2": v2,
    }),
    binding,
  });

  const found = await runtime.find!(docRef, { query: "Date:", mode: "text" });
  assert.equal(found.status, "success");
  if (found.status === "success") {
    assert.equal(found.matches.length, 2);
    assert.equal(found.matches[0]!.handle, "docx:find:1");
    assert.match(found.matches[0]!.location, /paragraph #1/);
    assertNoEngineSourceIdentities(found);
  }

  // Exact version: still ver-1 even when ver-2 exists in the loader map.
  assert.equal(binding.findCalls.length, 1);
  assert.deepEqual(Buffer.from(binding.findCalls[0]!.input), v1);
});

test("find mode semantic is honestly unsupported", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding(),
  });

  const result = await runtime.find!(docRef, {
    query: "x",
    mode: "semantic",
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }
});

test("find invalid document maps diagnostics without artifact fallback", async () => {
  const binding = createFakeDocxEngineBinding({
    findDocxText: () => ({
      ok: false,
      query: "x",
      matchCount: 0,
      matches: [],
      diagnostics: [
        {
          code: "INVALID_ZIP",
          severity: "error",
          message: "bad package",
        },
      ],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": Buffer.from("not a docx"),
    }),
    binding,
  });

  const result = await runtime.find!(docRef, { query: "x", mode: "text" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.diagnostics[0]!.code, "DOCUMENT_INVALID");
  }
});

test("inspect maps overview/headings/paragraphs/tables/context without mock fallback", async () => {
  const inputBytes = buildMinimalDocx(["target text", "nearby"]);
  const v2 = buildMinimalDocx(["other version"]);
  const binding = createFakeDocxEngineBinding({
    inspectDocx: (input, request) => {
      assert.deepEqual(Buffer.from(input), inputBytes);
      if (request.focus.kind === "overview") {
        return {
          ok: true,
          focus: "overview",
          overview: {
            bodyBlockCount: 5,
            paragraphCount: 4,
            tableCount: 1,
            sectionCount: 1,
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "headings") {
        assert.equal(request.focus.offset, 0);
        assert.equal(request.focus.limit, 20);
        return {
          ok: true,
          focus: "headings",
          headings: {
            page: { total: 1, offset: 0, returned: 1, hasMore: false },
            items: [
              {
                occurrence: 0,
                text: "Report",
                styleName: "Heading 1",
                level: 1,
              },
            ],
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "paragraphs") {
        assert.equal(request.focus.offset, 1);
        assert.equal(request.focus.limit, 2);
        return {
          ok: true,
          focus: "paragraphs",
          paragraphs: {
            page: { total: 4, offset: 1, returned: 2, hasMore: true },
            items: [
              {
                index: 1,
                handle: "b2",
                targetOccurrence: 0,
                text: "old text",
                styleName: "Body Text",
              },
              {
                index: 2,
                handle: "b3",
                targetOccurrence: 1,
                text: "more",
                styleName: "Body Text",
              },
            ],
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "tables") {
        assert.equal(request.focus.offset, 0);
        assert.equal(request.focus.limit, 10);
        return {
          ok: true,
          focus: "tables",
          tables: {
            page: { total: 1, offset: 0, returned: 1, hasMore: false },
            items: [
              {
                occurrence: 0,
                handle: "t0",
                rowCount: 3,
                isRectangular: false,
                columns: [
                  { occurrence: 0, handle: "t0:c0", text: "Name" },
                  { occurrence: 1, handle: "t0:c1", text: "Role" },
                ],
                rows: [
                  {
                    handle: "t0:r0",
                    cells: ["Name", "Role"],
                    cellHandles: ["t0:r0:c0", "t0:r0:c1"],
                  },
                  {
                    handle: "t0:r1",
                    cells: ["Alice", "CEO"],
                    cellHandles: ["t0:r1:c0", "t0:r1:c1"],
                  },
                  {
                    handle: "t0:r2",
                    cells: ["Bob", "CTO", "extra"],
                    cellHandles: ["t0:r2:c0", "t0:r2:c1", "t0:r2:c2"],
                  },
                ],
              },
            ],
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "context") {
        assert.equal(request.focus.text, "target text");
        assert.equal(request.focus.before, 1);
        assert.equal(request.focus.after, 0);
        return {
          ok: true,
          focus: "context",
          context: {
            target: { text: "target text" },
            container: {
              relativePosition: 0,
              text: "target text",
              container: "paragraph",
            },
            nearby: [
              {
                relativePosition: -1,
                text: "nearby",
                container: "paragraph",
              },
            ],
          },
          diagnostics: [],
        };
      }
      throw new Error(`unexpected focus ${JSON.stringify(request.focus)}`);
    },
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": inputBytes,
      "ver-2": v2,
    }),
    binding,
  });

  const overview = await runtime.inspect(docRef, { focus: { kind: "overview" } });
  assert.equal(overview.status, "success");
  if (overview.status === "success" && overview.payload.format === "docx") {
    assert.equal(overview.payload.overview?.tableCount, 1);
    assert.equal(overview.payload.overview?.paragraphCount, 4);
  }

  const headings = await runtime.inspect(docRef, { focus: { kind: "headings" } });
  assert.equal(headings.status, "success");
  if (headings.status === "success" && headings.payload.format === "docx") {
    assert.equal(headings.payload.headings?.[0]?.text, "Report");
    assert.equal(headings.payload.headings?.[0]?.styleName, "Heading 1");
    assert.equal(headings.payload.page?.total, 1);
  }

  const paragraphs = await runtime.inspect(docRef, {
    focus: { kind: "paragraphs", offset: 1, limit: 2 },
  });
  assert.equal(paragraphs.status, "success");
  if (paragraphs.status === "success" && paragraphs.payload.format === "docx") {
    assert.equal(paragraphs.payload.paragraphs?.[0]?.text, "old text");
    assert.deepEqual(paragraphs.payload.paragraphs?.[0], {
      handle: "b2",
      text: "old text",
      occurrence: 1,
      styleName: "Body Text",
    });
    assert.equal(paragraphs.payload.page?.hasMore, true);
  }

  const tables = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 10 },
  });
  assert.equal(tables.status, "success");
  if (tables.status === "success" && tables.payload.format === "docx") {
    const table = tables.payload.tables?.[0];
    assert.ok(table);
    assert.equal(table.isRectangular, false);
    assert.deepEqual(table.cells, [
      ["Name", "Role"],
      ["Alice", "CEO"],
      ["Bob", "CTO", "extra"],
    ]);
    assert.equal(table.rowCount, 3);
    assert.equal(table.handle, "t0");
    assert.equal(table.rows?.[2]?.cells[2]?.handle, "t0:r2:c2");
    assert.equal(table.cols, 3);
    assert.equal(tables.payload.page?.returned, 1);
    assertNoEngineSourceIdentities(tables);
  }

  const context = await runtime.inspect(docRef, {
    focus: { kind: "context", text: "target text", before: 1, after: 0 },
  });
  assert.equal(context.status, "success");
  if (context.status === "success" && context.payload.format === "docx") {
    assert.equal(context.payload.context?.container?.text, "target text");
  }

  // Exact version: still ver-1 even when ver-2 exists.
  assert.equal(binding.inspectCalls.length, 5);
  for (const call of binding.inspectCalls) {
    assert.deepEqual(Buffer.from(call.input), inputBytes);
  }

  const slides = await runtime.inspect(docRef, { focus: { kind: "slides" } });
  assert.equal(slides.status, "error");
  if (slides.status === "error") {
    assert.equal(slides.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }
  assert.equal(binding.inspectCalls.length, 5);
});

test("inspect invalid bounds and invalid DOCX stay structured", async () => {
  const binding = createFakeDocxEngineBinding({
    inspectDocx: () => ({
      ok: false,
      focus: "overview",
      diagnostics: [
        { code: "INVALID_ZIP", severity: "error", message: "bad package" },
      ],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": Buffer.from("not a docx"),
    }),
    binding,
  });

  const invalidDoc = await runtime.inspect(docRef, {
    focus: { kind: "overview" },
  });
  assert.equal(invalidDoc.status, "error");
  if (invalidDoc.status === "error") {
    assert.equal(invalidDoc.diagnostics[0]!.code, "DOCUMENT_INVALID");
  }

  const appBounds = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: -1, limit: 5 },
  });
  assert.equal(appBounds.status, "error");
  if (appBounds.status === "error") {
    assert.equal(appBounds.diagnostics[0]!.code, "INVALID_INSPECTION_BOUNDS");
  }
  // Invalid app bounds never reach the binding.
  assert.equal(binding.inspectCalls.length, 1);

  const engineBoundsBinding = createFakeDocxEngineBinding({
    inspectDocx: () => ({
      ok: false,
      focus: "tables",
      diagnostics: [
        {
          code: "INVALID_INSPECTION_BOUNDS",
          severity: "error",
          message: "limit too large",
        },
      ],
    }),
  });
  const engineBoundsRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: engineBoundsBinding,
  });
  const engineBounds = await engineBoundsRuntime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 50 },
  });
  assert.equal(engineBounds.status, "error");
  if (engineBounds.status === "error") {
    assert.equal(
      engineBounds.diagnostics[0]!.code,
      "INVALID_INSPECTION_BOUNDS",
    );
  }
});

test("inspect after mutation uses advanced DocumentRef version bytes", async () => {
  const v1 = buildMinimalDocx(["Alice", "CEO"]);
  const v2 = buildMinimalDocx(["Alice", "CFO"]);
  const versions = new Map<string, Uint8Array>([
    ["ver-1", v1],
    ["ver-2", v2],
  ]);

  const binding = createFakeDocxEngineBinding({
    inspectDocx: (input, request) => {
      assert.equal(request.focus.kind, "tables");
      const isV2 = Buffer.from(input).equals(Buffer.from(v2));
      return {
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
              columns: [
                {
                  occurrence: 0,
                  handle: "t0:c0",
                  text: isV2 ? "CFO" : "CEO",
                },
              ],
              rows: [
                {
                  handle: "t0:r0",
                  cells: [isV2 ? "CFO" : "CEO"],
                  cellHandles: ["t0:r0:c0"],
                },
              ],
            },
          ],
        },
        diagnostics: [],
      };
    },
    executeDocxReplaceText: () => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [{ kind: "text_replaced", before: "CEO", after: "CFO" }],
      },
      output: v2,
    }),
  });

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

  const before = await runtime.inspect(docRef, {
    focus: { kind: "tables", offset: 0, limit: 5 },
  });
  assert.equal(before.status, "success");
  if (before.status === "success" && before.payload.format === "docx") {
    assert.equal(before.payload.tables?.[0]?.cells?.[0]?.[0], "CEO");
  }

  const mutated = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "CEO", replace: "CFO" },
  });
  assert.equal(mutated.status, "success");

  const after = await runtime.inspect(
    { ...docRef, versionId: "ver-2" },
    { focus: { kind: "tables", offset: 0, limit: 5 } },
  );
  assert.equal(after.status, "success");
  if (after.status === "success" && after.payload.format === "docx") {
    assert.equal(after.payload.tables?.[0]?.cells?.[0]?.[0], "CFO");
  }
});

test("document.inspect AgentTool returns structured tables from DocumentRuntime", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["table"]),
    }),
    binding: createFakeDocxEngineBinding({
      inspectDocx: (_input, request) => {
        assert.equal(request.focus.kind, "tables");
        return {
          ok: true,
          focus: "tables",
          tables: {
            page: { total: 1, offset: 0, returned: 1, hasMore: false },
            items: [
              {
                occurrence: 0,
                handle: "t0",
                rowCount: 3,
                isRectangular: true,
                columns: [
                  { occurrence: 0, handle: "t0:c0", text: "Name" },
                  { occurrence: 1, handle: "t0:c1", text: "Role" },
                ],
                rows: [
                  {
                    handle: "t0:r0",
                    cells: ["Name", "Role"],
                    cellHandles: ["t0:r0:c0", "t0:r0:c1"],
                  },
                  {
                    handle: "t0:r1",
                    cells: ["Alice", "CEO"],
                    cellHandles: ["t0:r1:c0", "t0:r1:c1"],
                  },
                  {
                    handle: "t0:r2",
                    cells: ["Bob", "CTO"],
                    cellHandles: ["t0:r2:c0", "t0:r2:c1"],
                  },
                ],
              },
            ],
          },
          diagnostics: [],
        };
      },
    }),
  });

  const tool = createDocumentInspectTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docRef,
    runtime,
  });
  const result = await tool.execute(
    { focus: { kind: "tables", offset: 0, limit: 10 } },
    ctx,
  );
  assert.equal(result.status, "success");
  if (result.status === "success" && result.payload.format === "docx") {
    assert.deepEqual(result.payload.tables?.[0]?.cells, [
      ["Name", "Role"],
      ["Alice", "CEO"],
      ["Bob", "CTO"],
    ]);
  }
});

test("TARGET_NOT_FOUND maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["hello"]),
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
  if (result.status === "error") {
    assert.equal(result.code, "TARGET_NOT_FOUND");
    assert.equal("artifactBytes" in result, false);
  }
});

test("TARGET_AMBIGUOUS maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["Date:", "Date:"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "TARGET_AMBIGUOUS",
              severity: "error",
              message: "ambiguous",
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
    payload: { find: "Date:", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "TARGET_AMBIGUOUS");
  }
});

test("PRECONDITION_FAILED maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "PRECONDITION_FAILED",
              severity: "error",
              message: "stale expected text",
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
    payload: {
      find: "old text",
      replace: "x",
      expectedCurrentText: "different",
    },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "PRECONDITION_FAILED");
  }
});

test("INVALID_ZIP from engine normalizes to DOCUMENT_INVALID", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": Buffer.from("not a docx"),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "INVALID_ZIP",
              severity: "error",
              message: "bad package",
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
    payload: { find: "x", replace: "y" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "DOCUMENT_INVALID");
    assert.equal(result.diagnostics[0]?.code, "DOCUMENT_INVALID");
  }
});

test("baseVersionId mismatch is application CONFLICT before binding", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxReplaceText: () => {
      throw new Error("should not call binding");
    },
  });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-stale",
    payload: { find: "old text", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "CONFLICT");
  }
  assert.equal(binding.replaceCalls.length, 0);
});

test("AgentTool depends only on DocumentRuntime, not N-API package", async () => {
  const outputBytes = buildMinimalDocx(["replaced"]);
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: true,
          status: "applied",
          diagnostics: [],
          changes: [
            { kind: "text_replaced", before: "old text", after: "replaced" },
          ],
        },
        output: outputBytes,
      }),
    }),
  });

  const tool = createDocumentReplaceTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docRef,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  });

  const result = await tool.execute(
    { find: "old text", replace: "replaced" },
    ctx,
  );
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.document.versionId, "ver-1+1");
    assert.equal(result.baseVersionId, "ver-1");
  }
  assert.equal(
    Object.hasOwn(
      await import("@opensuite/agent-core"),
      "executeDocxReplaceText",
    ),
    false,
  );
});

test("maps table mutation payloads to binding DTOs", () => {
  const cells = mapSetTableCellsTextOperation({
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      updates: [
        {
          rowLabel: "Alice",
          columnHeader: "Role",
          expectedCurrentText: "CEO",
          replacement: "Founder & CEO",
        },
      ],
    },
  });
  assert.equal(cells.ok, true);
  if (!cells.ok) return;
  assert.deepEqual(cells.operation.updates[0]?.target, {
    rowLabel: "Alice",
    columnHeader: "Role",
  });

  const byHandle = mapSetTableCellsTextOperation({
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      updates: [
        {
          target: { handle: "t0:r4:c0" },
          expectedCurrentText: "",
          replacement: "Guest Panelist",
        },
      ],
    },
  });
  assert.equal(byHandle.ok, true);
  if (!byHandle.ok) return;
  assert.deepEqual(byHandle.operation.table, { handle: "t0" });
  assert.deepEqual(byHandle.operation.updates[0]?.target, {
    handle: "t0:r4:c0",
  });

  const rows = mapInsertTableRowsOperation({
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
  assert.equal(rows.ok, true);
  if (!rows.ok) return;
  assert.equal(rows.operation.rows.length, 2);

  const rowsByHandle = mapInsertTableRowsOperation({
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      after: { handle: "t0:r2" },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(rowsByHandle.ok, true);
  if (!rowsByHandle.ok) return;
  assert.deepEqual(rowsByHandle.operation.after, { handle: "t0:r2" });

  const column = mapInsertTableColumnOperation({
    type: "document.insert_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["New York", "Seattle"],
    },
  });
  assert.equal(column.ok, true);
  if (!column.ok) return;
  assert.equal(column.operation.header, "Location");

  const columnByHandle = mapInsertTableColumnOperation({
    type: "document.insert_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], handle: "t0" },
      afterColumnHandle: "t0:c1",
      header: "Location",
      cells: ["New York", "Seattle"],
    },
  });
  assert.equal(columnByHandle.ok, true);
  if (!columnByHandle.ok) return;
  assert.equal(columnByHandle.operation.afterColumnHandle, "t0:c1");
  assert.deepEqual(columnByHandle.operation.table.headerCells, [
    "Name",
    "Role",
  ]);

  const columnHandleOnlyRejected = mapInsertTableColumnOperation({
    type: "document.insert_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { handle: "t0" },
      afterColumnHandle: "t0:c1",
      header: "Location",
      cells: ["New York", "Seattle"],
    },
  });
  assert.equal(columnHandleOnlyRejected.ok, false);
  if (columnHandleOnlyRejected.ok) return;
  assert.equal(columnHandleOnlyRejected.error.status, "error");
  assert.equal(columnHandleOnlyRejected.error.code, "VALIDATION_FAILED");
});

test("execute set_table_cells_text returns verified artifact once", async () => {
  const outputBytes = buildMinimalDocx(["mutated"]);
  const binding = createFakeDocxEngineBinding({
    executeDocxSetTableCellsText: () => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [{ kind: "table_cells", before: "CEO", after: "Founder & CEO" }],
      },
      output: outputBytes,
    }),
  });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding,
  });
  const result = await runtime.execute!(docRef, {
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      updates: [
        {
          rowLabel: "Alice",
          columnHeader: "Role",
          expectedCurrentText: "CEO",
          replacement: "Founder & CEO",
        },
      ],
    },
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.ok(result.artifactBytes);
    assert.equal(binding.setCellsCalls.length, 1);
  }
  assertNoEngineSourceIdentities(result);
});

test("execute insert_table_rows and insert_table_column map to binding", async () => {
  const outputBytes = buildMinimalDocx(["rows"]);
  const binding = createFakeDocxEngineBinding({
    executeDocxInsertTableRows: () => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [{ kind: "table_rows", before: "", after: "Charlie" }],
      },
      output: outputBytes,
    }),
    executeDocxInsertTableColumn: () => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [{ kind: "table_column", before: "", after: "Location" }],
      },
      output: outputBytes,
    }),
  });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding,
  });

  const rows = await runtime.execute!(docRef, {
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      after: { firstCellText: "Bob" },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(rows.status, "success");
  assert.equal(binding.insertRowsCalls.length, 1);

  const column = await runtime.execute!(docRef, {
    type: "document.insert_table_column",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"] },
      afterColumnHeader: "Role",
      header: "Location",
      cells: ["NY", "SEA"],
    },
  });
  assert.equal(column.status, "success");
  assert.equal(binding.insertColumnCalls.length, 1);
});

test("adapter maps occurrence 0/null to omitted for table mutations", () => {
  const rows = mapInsertTableRowsOperation({
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], occurrence: 0 },
      after: { firstCellText: "Bob", occurrence: null },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(rows.ok, true);
  if (!rows.ok) return;
  assert.equal(Object.hasOwn(rows.operation.table, "occurrence"), false);
  assert.equal(Object.hasOwn(rows.operation.after, "occurrence"), false);

  const cells = mapSetTableCellsTextOperation({
    type: "document.set_table_cells_text",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], occurrence: "" },
      updates: [
        {
          rowLabel: "Alice",
          columnHeader: "Role",
          expectedCurrentText: "CEO",
          replacement: "Founder",
          occurrence: 0,
        },
      ],
    },
  });
  assert.equal(cells.ok, true);
  if (!cells.ok) return;
  assert.equal(Object.hasOwn(cells.operation.table, "occurrence"), false);
  assert.equal(
    Object.hasOwn(cells.operation.updates[0]!.target, "occurrence"),
    false,
  );
});

test("adapter keeps occurrence 1/2 and rejects -1", () => {
  const ok = mapInsertTableRowsOperation({
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], occurrence: 2 },
      after: { firstCellText: "Bob", occurrence: 1 },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.operation.table.occurrence, 2);
  assert.equal(ok.operation.after.occurrence, 1);

  const bad = mapInsertTableRowsOperation({
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], occurrence: -1 },
      after: { firstCellText: "Bob" },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(bad.ok, false);
});

test("execute insert_table_rows with occurrence 0 reaches binding once without occurrence", async () => {
  const outputBytes = buildMinimalDocx(["rows"]);
  const binding = createFakeDocxEngineBinding({
    executeDocxInsertTableRows: (_input, operation) => {
      assert.equal(Object.hasOwn(operation.table, "occurrence"), false);
      assert.equal(Object.hasOwn(operation.after, "occurrence"), false);
      return {
        result: {
          ok: true,
          status: "applied",
          diagnostics: [],
          changes: [{ kind: "table_rows", before: "", after: "Charlie" }],
        },
        output: outputBytes,
      };
    },
  });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding,
  });
  const result = await runtime.execute!(docRef, {
    type: "document.insert_table_rows",
    baseVersionId: "ver-1",
    payload: {
      table: { headerCells: ["Name", "Role"], occurrence: 0 },
      after: { firstCellText: "Bob", occurrence: 0 },
      rows: [["Charlie", "CFO"]],
    },
  });
  assert.equal(result.status, "success");
  assert.equal(binding.insertRowsCalls.length, 1);
});
