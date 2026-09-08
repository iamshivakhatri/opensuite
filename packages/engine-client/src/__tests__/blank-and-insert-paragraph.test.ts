import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  ArtifactHandleRegistry,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  ToolRegistry,
  assistantOnlyResponse,
  collectOpaqueHandles,
  createDocumentAgentRunnerOptions,
  createDocumentInsertParagraphTool,
  createDocumentInspectTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createScriptedAgentModel,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  toolCallResponse,
  type DocumentRef,
  type DocumentRuntime,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  createOpenSuiteEngineAdapter,
  mapInsertParagraphOperation,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("blank DOCX comes from binding (Rust bytes), not TypeScript XML", () => {
  const sentinel = new Uint8Array([9, 8, 7, 6, 5]);
  const binding = createFakeDocxEngineBinding({
    createBlankDocx: () => sentinel,
  });
  const bytes = binding.createBlankDocx();
  assert.deepEqual(bytes, sentinel);
  assert.notEqual(bytes, new TextEncoder().encode("<?xml"));
});

test("body_blocks mapping preserves handle/order/kind", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding({
      inspectDocx: () => ({
        ok: true,
        focus: "body_blocks",
        bodyBlocks: {
          page: { total: 2, offset: 0, returned: 2, hasMore: false },
          items: [
            { handle: "b0", kind: "paragraph", text: "Title" },
            { handle: "b1", kind: "table", tableHandle: "t0" },
          ],
        },
        diagnostics: [],
      }),
    }),
  });

  const result = await runtime.inspect(docRef, {
    focus: { kind: "body_blocks", offset: 0, limit: 20 },
  });
  assert.equal(result.status, "success");
  if (result.status !== "success" || result.payload.format !== "docx") {
    assert.fail("expected body_blocks");
  }
  assert.deepEqual(result.payload.bodyBlocks, [
    { handle: "b0", kind: "paragraph", text: "Title" },
    { handle: "b1", kind: "table", tableHandle: "t0" },
  ]);
  assert.deepEqual(collectOpaqueHandles(result.payload), ["b0", "b1"]);
});

test("insert_paragraph maps placement args to engine DTO", () => {
  const mapped = mapInsertParagraphOperation({
    type: "document.insert_paragraph",
    baseVersionId: "ver-1",
    payload: {
      text: "Hello",
      placement: { kind: "before", handle: "b1" },
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    text: "Hello",
    placement: { kind: "before", handle: "b1" },
    baseRevision: "ver-1",
  });
});

test("insert_paragraph tool is capability-gated", () => {
  const without = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    mutableDocumentCapabilities(),
  ).filter((t) => t.requireCapability === DOCX_ENGINE_CAPS.insertParagraph);
  assert.equal(without.length, 1);

  const gatedOut = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    {
      ids: new Set([
        "document.inspect",
        "document.find",
        "document.mutate",
        DOCX_ENGINE_CAPS.replaceText,
      ]),
    },
  ).map((t) => t.name);
  assert.equal(gatedOut.includes(DOCUMENT_TOOL_NAMES.insertParagraph), false);
});

test("insert_paragraph persists via executor and advances DocumentRef", async () => {
  const events: string[] = [];
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        diagnostics: [],
        focus: { kind: "body_blocks" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          bodyBlocks: [{ handle: "b1", kind: "table", tableHandle: "t0" }],
        },
      };
    },
    async execute(_document, operation) {
      executeCount += 1;
      assert.equal(operation.type, "document.insert_paragraph");
      assert.deepEqual(operation.payload, {
        text: "Board Action Items",
        placement: { kind: "before", handle: "b1" },
      });
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.insert_paragraph",
          area: "body",
          before: "",
          after: "Board Action Items",
        },
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "insp",
          name: DOCUMENT_TOOL_NAMES.inspect,
          input: { focus: { kind: "body_blocks" } },
        },
      ]),
      toolCallResponse("", [
        {
          id: "i1",
          name: DOCUMENT_TOOL_NAMES.insertParagraph,
          input: {
            text: "Board Action Items",
            placement: { kind: "before", handle: "b1" },
          },
        },
      ]),
      assistantOnlyResponse("inserted"),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docRef,
    }),
    capabilities: mutableDocumentCapabilities(),
    events: {
      async emit(event) {
        events.push(event.type);
      },
    },
  });

  const result = await runner.run({
    instruction: "insert above table",
    threadId: "t1",
    runId: "run-insert-p",
    primaryDocument: docRef,
  });

  assert.equal(result.status, "completed");
  const inserted = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.insertParagraph,
  );
  assert.equal(inserted?.status, "succeeded");
  assert.equal(executeCount, 1);
  assert.ok(events.includes("document.version.advanced"));
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === DOCUMENT_TOOL_NAMES.insertParagraph &&
        o.status === "succeeded" &&
        o.output &&
        typeof o.output === "object" &&
        "document" in o.output &&
        (o.output as { document: DocumentRef }).document.versionId ===
          "ver-1+1",
    ),
  );
});

test("stale body-block handle rejected after mutation; fresh inspect restores", async () => {
  let version = "ver-1";
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect(document) {
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        diagnostics: [],
        focus: { kind: "body_blocks" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          bodyBlocks: [
            { handle: "b0", kind: "paragraph", text: `at ${document.versionId}` },
          ],
        },
      };
    },
    async execute(document) {
      version = `${document.versionId}+1`;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  const tool = createDocumentInsertParagraphTool();
  const inspect = createDocumentInspectTool();
  const handles = new ArtifactHandleRegistry();
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const ctxV1 = createFakeToolExecutionContext({
    primaryDocument: { ...docRef, versionId: "ver-1" },
    runtime,
    mutations,
    handles,
  });

  await inspect.execute({ focus: { kind: "body_blocks" } }, ctxV1);
  assert.equal(handles.origin("b0"), "ver-1");

  const first = await tool.execute(
    { text: "A", placement: { kind: "end" } },
    ctxV1,
  );
  assert.equal(first.status, "success");
  const v2 = first.document.versionId;

  // Reuse old b0 against advanced DocumentRef → STALE_HANDLE
  await assert.rejects(
    () =>
      tool.execute(
        {
          text: "B",
          placement: { kind: "after", handle: "b0" },
        },
        {
          ...ctxV1,
          primaryDocument: { ...docRef, versionId: v2 },
        },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "STALE_HANDLE",
  );

  // Re-inspect at v2 → fresh handles valid
  const ctxV2 = createFakeToolExecutionContext({
    primaryDocument: { ...docRef, versionId: v2 },
    runtime,
    mutations,
    handles,
  });
  await inspect.execute({ focus: { kind: "body_blocks" } }, ctxV2);
  assert.equal(handles.origin("b0"), v2);

  const second = await tool.execute(
    { text: "C", placement: { kind: "after", handle: "b0" } },
    ctxV2,
  );
  assert.equal(second.status, "success");
  void version;
});

test("structured insert_paragraph diagnostic survives adapter", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxInsertParagraph: () => ({
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              reasonCode: "INVALID_BODY_BLOCK_HANDLE",
              operation: "insert_paragraph",
              targetHandle: "b9",
              message: "unknown body block",
            },
          ],
          changes: [],
        },
      }),
    }),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.insert_paragraph",
    baseVersionId: "ver-1",
    payload: {
      text: "x",
      placement: { kind: "before", handle: "b9" },
    },
  });
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.diagnostics[0]?.reasonCode, "INVALID_BODY_BLOCK_HANDLE");
  assert.equal(result.diagnostics[0]?.operation, "insert_paragraph");
  assert.equal(result.diagnostics[0]?.targetHandle, "b9");
});

test("native: blank DOCX + body_blocks + insert_paragraph", async (t) => {
  let binding;
  try {
    binding = await createNapiDocxEngineBinding();
  } catch (error) {
    t.skip(
      `Native binding unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const blank = binding.createBlankDocx();
  assert.ok(blank.byteLength > 0);
  // ZIP local file header
  assert.equal(blank[0], 0x50);
  assert.equal(blank[1], 0x4b);

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": blank }),
    binding,
  });

  const empty = await runtime.inspect(docRef, {
    focus: { kind: "body_blocks" },
  });
  assert.equal(empty.status, "success");
  if (empty.status === "success" && empty.payload.format === "docx") {
    assert.equal(empty.payload.bodyBlocks?.length ?? 0, 0);
  }

  const inserted = await runtime.execute!(docRef, {
    type: "document.insert_paragraph",
    baseVersionId: "ver-1",
    payload: { text: "Quarterly Operations Report", placement: { kind: "end" } },
  });
  assert.equal(inserted.status, "success");
  if (inserted.status !== "success" || !inserted.artifactBytes) {
    assert.fail("expected artifact bytes");
  }

  const runtime2 = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-2": inserted.artifactBytes,
    }),
    binding,
  });
  const blocks = await runtime2.inspect(
    { ...docRef, versionId: "ver-2" },
    { focus: { kind: "body_blocks" } },
  );
  assert.equal(blocks.status, "success");
  if (blocks.status === "success" && blocks.payload.format === "docx") {
    assert.equal(blocks.payload.bodyBlocks?.[0]?.handle, "b0");
    assert.equal(blocks.payload.bodyBlocks?.[0]?.kind, "paragraph");
    assert.equal(
      blocks.payload.bodyBlocks?.[0]?.text,
      "Quarterly Operations Report",
    );
  }
});
