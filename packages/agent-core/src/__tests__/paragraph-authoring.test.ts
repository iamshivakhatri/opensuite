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
  createDocumentDeleteParagraphTool,
  createDocumentInsertParagraphsTool,
  createDocumentInspectTool,
  createDocumentSetParagraphFormattingTool,
  createDocumentSetParagraphStyleTool,
  createDocumentSetTextFormattingTool,
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

const PARAGRAPH_TOOLS = [
  DOCUMENT_TOOL_NAMES.insertParagraph,
  DOCUMENT_TOOL_NAMES.insertParagraphs,
  DOCUMENT_TOOL_NAMES.deleteParagraph,
  DOCUMENT_TOOL_NAMES.setParagraphStyle,
  DOCUMENT_TOOL_NAMES.setParagraphFormatting,
  DOCUMENT_TOOL_NAMES.setTextFormatting,
] as const;

test("all paragraph authoring tools expose when runtime advertises caps", () => {
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    mutableDocumentCapabilities(),
  ).map((t) => t.name);
  for (const name of PARAGRAPH_TOOLS) {
    assert.ok(names.includes(name), `expected ${name}`);
  }
});

test("absent capability omits corresponding paragraph tool", () => {
  const caps = createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.replaceText,
    DOCX_ENGINE_CAPS.insertParagraph,
    // deliberately omit insert_paragraphs and delete/style/format
  );
  const names = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => t.name);
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.insertParagraph));
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.insertParagraphs), false);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.deleteParagraph), false);
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.setParagraphStyle), false);
  assert.equal(
    names.includes(DOCUMENT_TOOL_NAMES.setParagraphFormatting),
    false,
  );
  assert.equal(names.includes(DOCUMENT_TOOL_NAMES.setTextFormatting), false);
});

test("PPTX/XLSX mock caps do not receive paragraph tools", () => {
  for (const format of ["pptx", "xlsx"] as const) {
    const names = filterDocumentToolsByCapabilities(
      listDocumentToolDescriptors(),
      mockCapabilitiesForFormat(format),
    ).map((t) => t.name);
    for (const name of PARAGRAPH_TOOLS) {
      assert.equal(names.includes(name), false, `${format} must omit ${name}`);
    }
  }
});

test("insert_paragraphs maps args to one persisted mutation (one version)", async () => {
  let seen: unknown;
  let executeCount = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      executeCount += 1;
      seen = operation;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  };

  const tool = createDocumentInsertParagraphsTool();
  const result = await tool.execute(
    {
      texts: ["Title", "Intro", "Body", "More", "Conclusion"],
      placement: { kind: "end" },
    },
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  assert.equal(result.document.versionId, "ver-1+1");
  assert.deepEqual(seen, {
    type: "document.insert_paragraphs",
    baseVersionId: "ver-1",
    payload: {
      texts: ["Title", "Intro", "Body", "More", "Conclusion"],
      placement: { kind: "end" },
    },
  });
});

test("insert_paragraphs rejects embedded newlines with INVALID_TOOL_INPUT", () => {
  const tool = createDocumentInsertParagraphsTool();
  for (const bad of [
    ["Line one\nLine two"],
    ["ok", "has\rembedded"],
    ["a\nb\nc"],
  ]) {
    assert.throws(
      () =>
        tool.parseInput({
          texts: bad,
          placement: { kind: "end" },
        }),
      (error: unknown) =>
        error instanceof AgentCoreError &&
        error.code === "INVALID_TOOL_INPUT" &&
        /without embedded newlines|multiple entries/i.test(error.message),
      `expected reject for ${JSON.stringify(bad)}`,
    );
  }
});

test("insert_paragraphs still accepts multiple single-paragraph entries", () => {
  const tool = createDocumentInsertParagraphsTool();
  const parsed = tool.parseInput({
    texts: ["Title", "A related line.", "Another related line.", "Closing."],
    placement: { kind: "end" },
  });
  assert.deepEqual(parsed.texts, [
    "Title",
    "A related line.",
    "Another related line.",
    "Closing.",
  ]);
  assert.deepEqual(parsed.placement, { kind: "end" });
  assert.match(tool.description, /exactly one paragraph|no embedded newline/i);
  assert.match(tool.description, /multiple entries/i);
  assert.doesNotMatch(tool.description, /\bpoem\b/i);
});

test("AgentRunner first model call receives all paragraph tools when caps present", async () => {
  let firstToolNames: string[] | undefined;
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

  const runner = new AgentRunner({
    model: {
      async complete(request) {
        if (!firstToolNames) {
          firstToolNames = request.tools.map((t) => t.name);
        }
        return assistantOnlyResponse("ok");
      },
    },
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    capabilities: mutableDocumentCapabilities(),
  });

  await runner.run({
    instruction: "hi",
    threadId: "t1",
    runId: "run-caps",
    primaryDocument: docxRef,
  });

  assert.ok(firstToolNames);
  for (const name of PARAGRAPH_TOOLS) {
    assert.ok(firstToolNames!.includes(name), `first call missing ${name}`);
  }
});

test("set_paragraph_style / formatting / text formatting / delete persist one version each", async () => {
  const ops: string[] = [];
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      ops.push(operation.type);
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([ops.length]),
      };
    },
  };
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
  });

  const style = await createDocumentSetParagraphStyleTool().execute(
    { target: { text: "Title" }, style: "Heading 1" },
    ctx,
  );
  assert.equal(style.status, "success");
  assert.notEqual(style.document.versionId, docxRef.versionId);

  const paraFmt = await createDocumentSetParagraphFormattingTool().execute(
    {
      target: { text: "Title" },
      alignment: "center",
      spacingAfterTwips: 200,
    },
    { ...ctx, primaryDocument: style.document },
  );
  assert.equal(paraFmt.status, "success");
  assert.notEqual(paraFmt.document.versionId, style.document.versionId);

  const textFmt = await createDocumentSetTextFormattingTool().execute(
    { target: { text: "quiet glory" }, bold: true },
    { ...ctx, primaryDocument: paraFmt.document },
  );
  assert.equal(textFmt.status, "success");
  assert.notEqual(textFmt.document.versionId, paraFmt.document.versionId);

  const del = await createDocumentDeleteParagraphTool().execute(
    { target: { text: "Conclusion" } },
    { ...ctx, primaryDocument: textFmt.document },
  );
  assert.equal(del.status, "success");
  assert.notEqual(del.document.versionId, textFmt.document.versionId);

  assert.deepEqual(ops, [
    "document.set_paragraph_style",
    "document.set_paragraph_formatting",
    "document.set_text_formatting",
    "document.delete_paragraph",
  ]);
});

test("failed formatting/delete does not advance DocumentRef", async () => {
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      return {
        status: "error",
        code: "TARGET_NOT_FOUND",
        diagnostics: [
          {
            code: "TARGET_NOT_FOUND",
            severity: "error",
            message: "no match",
            reasonCode: "NO_MATCH",
            operation: "delete_paragraph",
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      createDocumentDeleteParagraphTool().execute(
        { target: { text: "Missing" } },
        createFakeToolExecutionContext({
          primaryDocument: docxRef,
          runtime,
          mutations: createInMemoryDocumentMutationExecutor(runtime),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AgentCoreError);
      // Application maps non-handle engine failures to TOOL_FAILURE; structured fields preserved.
      assert.equal(error.code, "TOOL_FAILURE");
      const diagnostic = error.diagnostic;
      assert.equal(diagnostic?.code, "TARGET_NOT_FOUND");
      assert.equal(diagnostic?.reasonCode, "NO_MATCH");
      assert.equal(diagnostic?.operation, "delete_paragraph");
      return true;
    },
  );
});

test("stale body-block handle rejected before runtime on insert_paragraphs", async () => {
  let executeCount = 0;
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
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([executeCount]),
      };
    },
  };

  const handles = new ArtifactHandleRegistry();
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const inspect = createDocumentInspectTool();
  const insert = createDocumentInsertParagraphsTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
    handles,
  });

  await inspect.execute({ focus: { kind: "body_blocks" } }, ctx);
  const first = await insert.execute(
    { texts: ["A"], placement: { kind: "end" } },
    ctx,
  );
  assert.equal(first.status, "success");
  const afterFirst = executeCount;

  await assert.rejects(
    () =>
      insert.execute(
        { texts: ["B"], placement: { kind: "after", handle: "b0" } },
        { ...ctx, primaryDocument: first.document },
      ),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "STALE_HANDLE",
  );
  assert.equal(executeCount, afterFirst);
});

test("batch insert_paragraphs appears as one tool outcome in AgentRunner", async () => {
  const events: string[] = [];
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
        artifactBytes: new Uint8Array([9]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "batch1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: ["a", "b", "c", "d", "e"],
            placement: { kind: "end" },
          },
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
    instruction: "write five paragraphs",
    threadId: "t1",
    runId: "run-batch",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.ok(events.includes("document.version.advanced"));
  const outcomes = result.toolOutcomes.filter(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.insertParagraphs,
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, "succeeded");
});
