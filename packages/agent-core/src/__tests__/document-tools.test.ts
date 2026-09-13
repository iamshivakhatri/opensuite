import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  Capabilities,
  createCapabilities,
  createDocumentCapabilitiesTool,
  createDocumentRunState,
  createDocumentToolContext,
  createDocumentToolRegistry,
  createInMemoryDocumentMutationExecutor,
  createFakeToolExecutionContext,
  createMockDocumentRuntime,
  createScriptedAgentModel,
  DOCUMENT_TOOL_NAMES,
  mockFixtureTitle,
  mutableDocumentCapabilities,
  readOnlyDocumentCapabilities,
  ToolRegistry,
  assistantOnlyResponse,
  toolCallResponse,
  type DocumentRef,
  type DocumentRuntime,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

const pptxRef: DocumentRef = {
  documentId: "doc-pptx",
  versionId: "ver-1",
  format: "pptx",
};

const xlsxRef: DocumentRef = {
  documentId: "doc-xlsx",
  versionId: "ver-1",
  format: "xlsx",
};

test("document tool registry advertises capabilities-aware tools", () => {
  const full = createDocumentToolRegistry();
  assert.deepEqual(
    full.list().map((t) => t.name),
    [DOCUMENT_TOOL_NAMES.find, DOCUMENT_TOOL_NAMES.inspect],
  );

  const inspectOnly = createDocumentToolRegistry(
    createCapabilities(Capabilities.DocumentInspect),
  );
  assert.deepEqual(
    inspectOnly.list().map((t) => t.name),
    [DOCUMENT_TOOL_NAMES.inspect],
  );

  const none = createDocumentToolRegistry(createCapabilities());
  assert.deepEqual(none.list().map((t) => t.name), []);
});

test("MockDocumentRuntime inspects DOCX/PPTX/XLSX fixtures", async () => {
  const runtime = createMockDocumentRuntime();

  const docx = await runtime.inspect(docxRef, { focus: { kind: "headings" } });
  assert.equal(docx.status, "success");
  if (docx.status === "success") {
    assert.equal(docx.payload.format, "docx");
    assert.equal(docx.payload.summary.title, mockFixtureTitle("docx"));
    assert.ok(docx.payload.headings && docx.payload.headings.length >= 3);
    assert.ok(
      docx.payload.headings?.some((h) => h.text === "Revenue Analysis"),
    );
  }

  const pptx = await runtime.inspect(pptxRef, { focus: { kind: "slides" } });
  assert.equal(pptx.status, "success");
  if (pptx.status === "success") {
    assert.equal(pptx.payload.format, "pptx");
    assert.equal(pptx.payload.summary.unitCount, 3);
    assert.ok(pptx.payload.slides?.some((s) => s.title === "Revenue Highlights"));
  }

  const xlsx = await runtime.inspect(xlsxRef, { focus: { kind: "sheets" } });
  assert.equal(xlsx.status, "success");
  if (xlsx.status === "success") {
    assert.equal(xlsx.payload.format, "xlsx");
    assert.deepEqual(
      xlsx.payload.sheets?.map((s) => s.name),
      ["Summary", "Revenue", "Expenses"],
    );
  }

  const range = await runtime.inspect(xlsxRef, {
    focus: { kind: "range", sheet: "Summary", address: "B2" },
  });
  assert.equal(range.status, "success");
  if (range.status === "success" && range.payload.format === "xlsx") {
    assert.equal(range.payload.cells?.[0]?.value, 44_800_000);
  }
});

test("MockDocumentRuntime find returns revenue matches", async () => {
  const runtime = createMockDocumentRuntime();
  assert.ok(runtime.find);
  const result = await runtime.find!(docxRef, {
    query: "revenue",
    mode: "semantic",
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.ok(result.matches.length >= 2);
    assert.ok(
      result.matches.some((m) => /revenue/i.test(m.excerpt)),
    );
  }
});

test("document tools require primary document", async () => {
  const tools = createDocumentToolRegistry();
  const inspect = tools.require(DOCUMENT_TOOL_NAMES.inspect);
  const ctx = createFakeToolExecutionContext({
    primaryDocument: null,
    runtime: createMockDocumentRuntime(),
  });
  await assert.rejects(
    () => inspect.execute(inspect.parseInput({}), ctx),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.diagnostic?.code === "PRIMARY_DOCUMENT_MISSING",
  );
});

test("document.inspect reuses an exact current inspection", async () => {
  const mock = createMockDocumentRuntime();
  let inspectCalls = 0;
  const runtime: DocumentRuntime = {
    ...mock,
    async inspect(document, options) {
      inspectCalls += 1;
      return mock.inspect(document, options);
    },
  };
  const state = createDocumentRunState(docxRef);
  const inspect = createDocumentToolRegistry().require(DOCUMENT_TOOL_NAMES.inspect);
  const context = createDocumentToolContext({ state, runtime })({
    runId: "r-inspect-reuse",
    signal: new AbortController().signal,
    events: { emit() {} },
  });
  const input = inspect.parseInput({ focus: { kind: "headings" } });

  await inspect.execute(input, context);
  const reused = await inspect.execute(input, context);

  assert.equal(inspectCalls, 1);
  assert.equal((reused as { reused?: boolean }).reused, true);
});

test("successful paragraph authoring records exact recent targets", async () => {
  const runtime: DocumentRuntime = {
    async capabilities() { return mutableDocumentCapabilities(); },
    async inspect() { throw new Error("unused"); },
    async execute() { return { status: "success", diagnostics: [], artifactBytes: new Uint8Array([1]) }; },
  };
  const state = createDocumentRunState(docxRef);
  const context = createDocumentToolContext({
    state,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  })({ runId: "r-recent-targets", signal: new AbortController().signal, events: { emit() {} } });
  const tools = createDocumentToolRegistry(mutableDocumentCapabilities());

  const batch = tools.require(DOCUMENT_TOOL_NAMES.insertParagraphs);
  await batch.execute(batch.parseInput({ texts: ["First", "Second"], placement: { kind: "end" } }), context);
  assert.deepEqual(state.working?.recentParagraphTargets, [
    { text: "First", duplicateInBatch: false },
    { text: "Second", duplicateInBatch: false },
  ]);

  const single = tools.require(DOCUMENT_TOOL_NAMES.insertParagraph);
  await single.execute(single.parseInput({ text: "Third", placement: { kind: "end" } }), createDocumentToolContext({
    state,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  })({ runId: "r-recent-targets", signal: new AbortController().signal, events: { emit() {} } }));
  assert.deepEqual(state.working?.recentParagraphTargets, [
    { text: "Third", duplicateInBatch: false },
  ]);
});

test("unsupported find capability returns structured failure", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: createCapabilities(Capabilities.DocumentInspect),
  });
  assert.ok(runtime.find);
  const result = await runtime.find!(docxRef, { query: "revenue" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.diagnostics[0]?.code, "UNSUPPORTED_CAPABILITY");
  }

  const tools = createDocumentToolRegistry(readOnlyDocumentCapabilities());
  const find = tools.require(DOCUMENT_TOOL_NAMES.find);
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
  });
  await assert.rejects(
    () => find.execute(find.parseInput({ query: "revenue" }), ctx),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.code === "UNSUPPORTED_CAPABILITY",
  );
});

test("AgentRunner loop: FakeAgentModel + document.inspect observation", async () => {
  const runtime = createMockDocumentRuntime();
  const tools = createDocumentToolRegistry();
  const state = createDocumentRunState(docxRef);
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: DOCUMENT_TOOL_NAMES.inspect,
          input: { focus: { kind: "headings" } },
        },
      ]),
      (request) => {
        const toolMsg = request.messages.find((m) => m.role === "tool");
        assert.ok(toolMsg && toolMsg.role === "tool");
        assert.equal(toolMsg.status, "succeeded");
        const output = toolMsg.output as { status?: string; payload?: { headings?: unknown[] } };
        assert.equal(output.status, "success");
        assert.ok(output.payload?.headings);
        return assistantOnlyResponse(
          `Sections: ${output.payload!.headings!.length}`,
        );
      },
    ]),
    tools,
    createToolContext: createDocumentToolContext({
      state,
      runtime,
    }),
    capabilities: readOnlyDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "What sections are in this document?",
    threadId: "t1",
    runId: "r1",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.match(result.summary, /Sections: /);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.equal(result.toolOutcomes[0]?.toolName, DOCUMENT_TOOL_NAMES.inspect);
  assert.equal(state.working?.documentId, docxRef.documentId);
  assert.equal(state.working?.versionId, docxRef.versionId);
  assert.equal(state.working?.focus?.kind, "headings");
});

test("AgentRunner loop: document.find then grounded reply", async () => {
  const runtime = createMockDocumentRuntime();
  const tools = createDocumentToolRegistry();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "revenue", mode: "semantic" },
        },
      ]),
      (request) => {
        const toolMsg = request.messages.find((m) => m.role === "tool");
        assert.ok(toolMsg && toolMsg.role === "tool");
        const output = toolMsg.output as {
          status?: string;
          matches?: { excerpt: string }[];
        };
        assert.equal(output.status, "success");
        assert.ok((output.matches?.length ?? 0) > 0);
        return assistantOnlyResponse(
          `Found ${output.matches!.length} revenue mentions.`,
        );
      },
    ]),
    tools,
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
    }),
  });

  const result = await runner.run({
    instruction: "Find every mention of revenue.",
    threadId: "t1",
    runId: "r1",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");
  assert.match(result.summary, /Found \d+ revenue mentions/);
});

test("document.capabilities factory reports read-only stack", async () => {
  const capsTool = createDocumentCapabilitiesTool();
  const result = (await capsTool.execute(
    {},
    createFakeToolExecutionContext({
      primaryDocument: xlsxRef,
      runtime: createMockDocumentRuntime(),
    }),
  )) as {
    format: string;
    canInspect: boolean;
    canFind: boolean;
    canMutate: boolean;
    capabilities: string[];
  };
  assert.equal(result.format, "xlsx");
  assert.equal(result.canInspect, true);
  assert.equal(result.canFind, true);
  assert.equal(result.canMutate, false);
  assert.ok(result.capabilities.includes(Capabilities.DocumentInspect));
});

test("ToolRegistry empty without document tools still works", () => {
  assert.equal(ToolRegistry.create([]).size, 0);
});
