import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  ArtifactHandleRegistry,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  ToolRegistry,
  assistantOnlyResponse,
  createCapabilities,
  createDocumentAgentRunnerOptions,
  createDocumentInsertParagraphTool,
  createDocumentInspectTool,
  createFakeAgentModel,
  createRecordingEventSink,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createScriptedAgentModel,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mockCapabilitiesForFormat,
  mutableDocumentCapabilities,
  toolCallResponse,
  type DocumentRef,
  type DocumentRuntime,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("insert_paragraph is advertised only when capability is present", () => {
  const withCap = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    mutableDocumentCapabilities(),
  ).map((t) => t.name);
  assert.ok(withCap.includes(DOCUMENT_TOOL_NAMES.insertParagraph));

  const without = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    createCapabilities(
      Capabilities.DocumentInspect,
      Capabilities.DocumentFind,
      Capabilities.DocumentMutate,
      DOCX_ENGINE_CAPS.replaceText,
    ),
  ).map((t) => t.name);
  assert.equal(without.includes(DOCUMENT_TOOL_NAMES.insertParagraph), false);
});

test("insert_paragraph tool maps args through persisted mutation path", async () => {
  let seen: unknown;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      seen = operation;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  const tool = createDocumentInsertParagraphTool();
  const result = await tool.execute(
    {
      text: "Hello board",
      placement: { kind: "start" },
    },
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.document.versionId, "ver-1+1");
  assert.deepEqual(seen, {
    type: "document.insert_paragraph",
    baseVersionId: "ver-1",
    payload: {
      text: "Hello board",
      placement: { kind: "start" },
    },
  });
});

test("AgentRunner advances DocumentRef and emits version event on insert_paragraph", async () => {
  const events: string[] = [];
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
          summary: { title: null, unitKind: "page", unitCount: 0 },
          bodyBlocks: [],
        },
      };
    },
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([9]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "p1",
          name: DOCUMENT_TOOL_NAMES.insertParagraph,
          input: { text: "Title", placement: { kind: "end" } },
        },
      ]),
      assistantOnlyResponse("done"),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    capabilities: mutableDocumentCapabilities(),
    events: {
      async emit(event) {
        events.push(event.type);
      },
    },
  });

  const result = await runner.run({
    instruction: "add title",
    threadId: "t1",
    runId: "run-p",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.ok(events.includes("document.version.advanced"));
  const outcome = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.insertParagraph,
  );
  assert.equal(outcome?.status, "succeeded");
});

test("PPTX mock capabilities still exclude insert_paragraph", () => {
  const caps = mockCapabilitiesForFormat("pptx");
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => t.name);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.insertParagraph), false);
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.updateSlideText));
});

test("stale body-block handle after insert is STALE_HANDLE", async () => {
  let n = 0;
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
            {
              handle: "b0",
              kind: "paragraph",
              text: document.versionId,
            },
          ],
        },
      };
    },
    async execute() {
      n += 1;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([n]),
      };
    },
  };

  const handles = new ArtifactHandleRegistry();
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const inspect = createDocumentInspectTool();
  const insert = createDocumentInsertParagraphTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
    handles,
  });

  await inspect.execute({ focus: { kind: "body_blocks" } }, ctx);
  const first = await insert.execute(
    { text: "A", placement: { kind: "end" } },
    ctx,
  );
  assert.equal(first.status, "success");

  await assert.rejects(
    () =>
      insert.execute(
        { text: "B", placement: { kind: "after", handle: "b0" } },
        {
          ...ctx,
          primaryDocument: first.document,
        },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
});

test("same-turn stale structural handles defer without blocking the next model turn", async () => {
  const seenVersions: string[] = [];
  const modelRequests: unknown[] = [];
  const runtime: DocumentRuntime = {
    async capabilities() { return mutableDocumentCapabilities(); },
    async inspect() {
      return {
        status: "success", format: "docx", capabilities: mutableDocumentCapabilities(), diagnostics: [],
        focus: { kind: "body_blocks" },
        payload: { format: "docx", summary: { title: null, unitKind: "page", unitCount: 1 }, bodyBlocks: [{ handle: "b0", kind: "paragraph", text: "Anchor" }] },
      };
    },
    async execute(document) {
      seenVersions.push(document.versionId);
      return { status: "success", diagnostics: [], artifactBytes: new Uint8Array([1]) };
    },
  };
  let turn = 0;
  const events = createRecordingEventSink();
  const mutations = {
    ...createInMemoryDocumentMutationExecutor(runtime),
    async flushPendingFormatting() { return { status: "noop" as const }; },
  };
  const runner = new AgentRunner({
    model: createFakeAgentModel({
      respond(request) {
        modelRequests.push({ messages: request.messages });
        turn += 1;
        if (turn === 1) return toolCallResponse("", [{ id: "inspect", name: DOCUMENT_TOOL_NAMES.inspect, input: { focus: { kind: "body_blocks" } } }]);
        if (turn === 2) return toolCallResponse("", [
          { id: "first", name: DOCUMENT_TOOL_NAMES.insertParagraph, input: { text: "First", placement: { kind: "after", handle: "b0" } } },
          { id: "stale", name: DOCUMENT_TOOL_NAMES.insertParagraph, input: { text: "Stale", placement: { kind: "after", handle: "b0" } } },
          { id: "after-barrier", name: DOCUMENT_TOOL_NAMES.insertParagraph, input: { text: "Also deferred", placement: { kind: "end" } } },
        ]);
        if (turn === 3) return toolCallResponse("", [{ id: "semantic", name: DOCUMENT_TOOL_NAMES.insertParagraph, input: { text: "Current", placement: { kind: "end" } } }]);
        return assistantOnlyResponse("Done.");
      },
    }),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]), documentToolCatalog: listDocumentToolDescriptors(), runtime, mutations, primaryDocument: docxRef,
    }),
    capabilities: mutableDocumentCapabilities(),
    events,
  });
  const result = await runner.run({ instruction: "insert", threadId: "t1", runId: "run-barrier", primaryDocument: docxRef });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.toolOutcomes.map((outcome) => outcome.status), ["succeeded", "succeeded", "deferred", "deferred", "succeeded"]);
  assert.deepEqual(seenVersions, ["ver-1", "ver-1+1"]);
  assert.equal(events.events.filter((event) => event.type === "tool.deferred").length, 2);
  assert.equal(events.events.filter((event) => event.type === "tool.failed").length, 0);
  const barrierRequest = modelRequests[2] as { readonly messages: readonly { readonly role: string; readonly toolCallId?: string; readonly status?: string }[] };
  assert.deepEqual(
    barrierRequest.messages.filter((message) => message.role === "tool").slice(-3).map((message) => [message.toolCallId, message.status]),
    [["first", "succeeded"], ["stale", "skipped"], ["after-barrier", "skipped"]],
  );
});

test("same-turn semantic targets run after a structural handle mutation", async () => {
  const seenVersions: string[] = [];
  const runtime: DocumentRuntime = {
    async capabilities() { return mutableDocumentCapabilities(); },
    async inspect() {
      return {
        status: "success", format: "docx", capabilities: mutableDocumentCapabilities(), diagnostics: [],
        focus: { kind: "body_blocks" },
        payload: { format: "docx", summary: { title: null, unitKind: "page", unitCount: 1 }, bodyBlocks: [{ handle: "b0", kind: "paragraph", text: "Anchor" }] },
      };
    },
    async execute(document) {
      seenVersions.push(document.versionId);
      return { status: "success", diagnostics: [], artifactBytes: new Uint8Array([1]) };
    },
  };
  const mutations = { ...createInMemoryDocumentMutationExecutor(runtime), async flushPendingFormatting() { return { status: "noop" as const }; } };
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "inspect", name: DOCUMENT_TOOL_NAMES.inspect, input: { focus: { kind: "body_blocks" } } }]),
      toolCallResponse("", [
        { id: "structural", name: DOCUMENT_TOOL_NAMES.insertParagraph, input: { text: "First", placement: { kind: "after", handle: "b0" } } },
        { id: "semantic", name: DOCUMENT_TOOL_NAMES.deleteParagraph, input: { target: { text: "Known" } } },
      ]),
      assistantOnlyResponse("Done."),
    ]),
    ...createDocumentAgentRunnerOptions({ tools: ToolRegistry.create([]), documentToolCatalog: listDocumentToolDescriptors(), runtime, mutations, primaryDocument: docxRef }),
    capabilities: mutableDocumentCapabilities(),
  });
  const result = await runner.run({ instruction: "edit", threadId: "t1", runId: "run-semantic", primaryDocument: docxRef });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.toolOutcomes.map((outcome) => outcome.status), ["succeeded", "succeeded", "succeeded"]);
  assert.deepEqual(seenVersions, ["ver-1", "ver-1+1"]);
});
