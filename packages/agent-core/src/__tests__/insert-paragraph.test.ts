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
