import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createDocumentRunState,
  createDocumentToolContext,
  advanceDocumentWorkingState,
  recordDocumentInspection,
  recordRecentParagraphTargets,
  findDocumentInspection,
  createFakeTool,
  createInMemoryDocumentMutationExecutor,
  createMockDocumentRuntime,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  requireCurrentArtifactHandles,
  toolCallResponse,
  type DocumentRef,
  type DocumentRuntime,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

test("run-state: inspection working state follows safe formatting changes only", () => {
  const state = createDocumentRunState(docxRef);
  recordDocumentInspection(state, docxRef, { kind: "tables" }, {
    payload: { tables: [{ handle: "t0", rows: [{ handle: "r0", cells: [{ handle: "c0", text: "A" }] }] }] },
  });
  assert.equal(state.working?.versionId, "ver-1");

  advanceDocumentWorkingState(state, { ...docxRef, versionId: "ver-2" }, true);
  assert.equal(state.working?.versionId, "ver-2");
  assert.equal(state.working?.freshness, "formatting-carried");
  assert.ok(!JSON.stringify(state.working).includes('"handle"'));

  advanceDocumentWorkingState(state, { ...docxRef, versionId: "ver-3" });
  assert.equal(state.working, null);
});

test("run-state: same-version inspections merge by exact coverage", () => {
  const state = createDocumentRunState(docxRef);
  recordDocumentInspection(state, docxRef, { kind: "paragraphs", offset: 0, limit: 20 }, { payload: { paragraphs: ["A"] } });
  recordDocumentInspection(state, docxRef, { kind: "headings" }, { payload: { headings: ["H"] } });
  assert.equal(state.working?.inspections.length, 2);
  assert.ok(findDocumentInspection(state, { kind: "headings" }));
  assert.equal(findDocumentInspection(state, { kind: "paragraphs", offset: 20, limit: 20 }), undefined);
});

test("run-state: recent paragraph targets are bounded, versioned, and formatting-safe", () => {
  const state = createDocumentRunState(docxRef);
  const authoredVersion = { ...docxRef, versionId: "ver-2" };
  advanceDocumentWorkingState(state, authoredVersion);
  recordRecentParagraphTargets(state, authoredVersion, ["Unique", "Repeat", "Repeat"]);

  assert.equal(state.working?.versionId, "ver-2");
  assert.deepEqual(state.working?.recentParagraphTargets, [
    { text: "Unique", duplicateInBatch: false },
    { text: "Repeat", duplicateInBatch: true },
    { text: "Repeat", duplicateInBatch: true },
  ]);
  assert.ok(!JSON.stringify(state.working).includes("occurrence"));

  advanceDocumentWorkingState(state, { ...docxRef, versionId: "ver-3" }, true);
  assert.equal(state.working?.recentParagraphTargets.length, 3);
  advanceDocumentWorkingState(state, { ...docxRef, versionId: "ver-4" });
  assert.equal(state.working, null);

  const boundedVersion = { ...docxRef, versionId: "ver-5" };
  const boundedState = createDocumentRunState(boundedVersion);
  recordRecentParagraphTargets(boundedState, boundedVersion, Array.from({ length: 20 }, (_, index) => `paragraph-${index}`));
  assert.equal(boundedState.working?.recentParagraphTargets.length, 16);
  assert.equal(boundedState.working?.recentParagraphTargets[0]?.text, "paragraph-4");
});

test("run-state: sequential writes observe N → N+1 → N+2 via createToolContext", async () => {
  const seenBaseVersions: string[] = [];
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(document) {
      seenBaseVersions.push(document.versionId);
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("Done — three writes.", [
        {
          id: "w1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: { texts: ["A"], placement: { kind: "end" } },
        },
        {
          id: "w2",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: { texts: ["B"], placement: { kind: "end" } },
        },
        {
          id: "w3",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: { texts: ["C"], placement: { kind: "end" } },
        },
      ]),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "write three paragraphs",
    threadId: "t1",
    runId: "r-seq-abc",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(seenBaseVersions.length, 3);
  assert.equal(seenBaseVersions[0], "ver-1");
  assert.notEqual(seenBaseVersions[1], seenBaseVersions[0]);
  assert.notEqual(seenBaseVersions[2], seenBaseVersions[1]);
});

test("run-state: handles stay valid across mutation; old handles go stale; reinspect restores", async () => {
  const state = createDocumentRunState(docxRef);
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const ctxFactory = createDocumentToolContext({ state, runtime, mutations });

  // Seed a handle as inspect would — registry is OpenSuite-owned run state.
  state.handles.register("h-seed", docxRef.versionId);
  assert.equal(state.handles.origin("h-seed"), "ver-1");

  requireCurrentArtifactHandles(
    ctxFactory({
      runId: "r-handles",
      signal: new AbortController().signal,
      events: { emit() {} },
    }),
    { handle: "h-seed" },
  );

  // Advance primary (as a mutation would) — old handle becomes stale.
  state.primary = {
    documentId: docxRef.documentId,
    versionId: "ver-2",
    format: "docx",
  };
  assert.throws(
    () =>
      requireCurrentArtifactHandles(
        ctxFactory({
          runId: "r-handles",
          signal: new AbortController().signal,
          events: { emit() {} },
        }),
        { handle: "h-seed" },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );

  // Re-register for new version (reinspect path).
  state.handles.register("h-seed", "ver-2");
  requireCurrentArtifactHandles(
    ctxFactory({
      runId: "r-handles",
      signal: new AbortController().signal,
      events: { emit() {} },
    }),
    { handle: "h-seed" },
  );

  // Sequential write context factory does not reset the registry.
  const beforeSize = state.handles.size;
  ctxFactory({
    runId: "r-handles",
    signal: new AbortController().signal,
    events: { emit() {} },
  });
  assert.equal(state.handles.size, beforeSize);
});

test("run-state: create_blank advances primary; next selector turn exposes DOCX tools", async () => {
  const createTool = createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async (_input, ctx) => {
      const document = {
        documentId: "new-doc",
        versionId: "v1",
        format: "docx" as const,
      };
      ctx.advancePrimaryDocument?.(document);
      return {
        document: { ...document, name: "N.docx", versionNumber: 1 },
      };
    },
  });

  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  let postCreateTools: string[] = [];
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "c1",
            name: "workspace.create_blank_docx",
            input: { name: "N.docx" },
          },
        ]),
      (request) => {
        postCreateTools = request.tools.map((t) => t.name);
        return toolCallResponse("Done — blank document ready.", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Title", "Body."],
              placement: { kind: "end" },
            },
          },
        ]);
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  });

  const result = await runner.run({
    instruction: "create a blank note",
    threadId: "t1",
    runId: "r-create-next-turn",
  });

  assert.equal(result.status, "completed");
  assert.ok(
    postCreateTools.some((n) => n === DOCUMENT_TOOL_NAMES.insertParagraphs),
    "DOCX authoring tools exposed after create advances primary",
  );
});
