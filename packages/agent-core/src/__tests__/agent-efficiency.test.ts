import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  assistantOnlyResponse,
  buildDocumentAgentSystemPrompt,
  createCapabilities,
  createDocumentAgentRunnerOptions,
  createDocumentAgentRunnerPolicyOptions,
  createDocumentCapabilitiesTool,
  createFakeTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createMockDocumentRuntime,
  createRecordingEventSink,
  createScriptedAgentModel,
  filterDocumentToolsByCapabilities,
  isPersistedDocumentMutationToolResult,
  listDocumentToolDescriptors,
  measureToolCatalogBytes,
  mutableDocumentCapabilities,
  projectToolResultForModel,
  readOnlyDocumentCapabilities,
  toolCallResponse,
  transformContext,
  type DocumentRef,
  type DocumentRuntime,
  type ModelMessage,
  type ModelRequest,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

test("model-facing catalog excludes document.capabilities", () => {
  const names = listDocumentToolDescriptors().map((t) => t.name);
  assert.ok(!names.includes(DOCUMENT_TOOL_NAMES.capabilities));
  assert.ok(names.includes(DOCUMENT_TOOL_NAMES.inspect));
});

test("DOCX run receives capability-gated tools without capabilities probe", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  let firstTools: string[] | undefined;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request: ModelRequest) => {
        firstTools = request.tools.map((t) => t.name);
        return assistantOnlyResponse("done");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    instruction: "hi",
    threadId: "t1",
    runId: "r-no-caps-tool",
    primaryDocument: docxRef,
  });

  assert.ok(firstTools);
  assert.ok(!firstTools!.includes(DOCUMENT_TOOL_NAMES.capabilities));
  assert.ok(firstTools!.includes(DOCUMENT_TOOL_NAMES.insertParagraphs));
  assert.ok(firstTools!.includes(DOCUMENT_TOOL_NAMES.createTable));
});

test("internal document.capabilities factory still works", async () => {
  const tool = createDocumentCapabilitiesTool();
  const result = await tool.execute(
    {},
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime: createMockDocumentRuntime({
        capabilities: readOnlyDocumentCapabilities(),
      }),
    }),
  );
  assert.equal(result.canMutate, false);
  assert.ok(result.capabilities.includes(Capabilities.DocumentInspect));
});

test("greenfield post-create batching: insert + table + insert in one model turn", async () => {
  const versions: string[] = [];
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
        change: {
          operation: operation.type,
          area:
            operation.type === "document.insert_paragraphs"
              ? `${(operation.payload.texts as string[]).length} paragraph(s)`
              : "table",
          before: "",
          after: "",
        },
        artifactBytes: new Uint8Array([ops.length]),
      };
    },
  };
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  let modelCalls = 0;

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request) => {
        modelCalls += 1;
        assert.ok(
          request.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.insertParagraphs),
        );
        return toolCallResponse("", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Title line", "Intro one.", "Intro two."],
              placement: { kind: "end" },
            },
          },
          {
            id: "w2",
            name: DOCUMENT_TOOL_NAMES.createTable,
            input: {
              rows: [
                ["A", "B"],
                ["1", "2"],
              ],
              placement: { kind: "end" },
            },
          },
          {
            id: "w3",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Conclusion one.", "Conclusion two."],
              placement: { kind: "end" },
            },
          },
        ]);
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("Created the document.");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations,
      primaryDocument: docxRef,
    }),
    events: {
      async emit(event) {
        if (event.type === "document.version.advanced") {
          versions.push(event.versionId);
        }
      },
    },
  });

  const result = await runner.run({
    instruction: "author content",
    threadId: "t1",
    runId: "r-batch-writes",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(versions.length, 3);
  assert.equal(result.toolOutcomes.length, 3);
  assert.deepEqual(
    result.toolOutcomes.map((o) => o.status),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.deepEqual(ops, [
    "document.insert_paragraphs",
    "document.create_table",
    "document.insert_paragraphs",
  ]);
  // Sequential version advancement — each write observes prior N+1.
  assert.equal(new Set(versions).size, 3);
  assert.notEqual(versions[0], docxRef.versionId);
  assert.notEqual(versions[1], versions[0]);
  assert.notEqual(versions[2], versions[1]);
  const versionNumbers = result.toolOutcomes.map((o) => {
    assert.ok(isPersistedDocumentMutationToolResult(o.output));
    return o.output.versionNumber;
  });
  assert.deepEqual(versionNumbers, [2, 3, 4]);
});

test("slim successful mutation results omit echoed prose", () => {
  const prose =
    "A long inserted paragraph that must not be echoed back into model context.";
  const canonical: Extract<ModelMessage, { role: "tool" }> = {
    role: "tool",
    toolCallId: "c1",
    toolName: DOCUMENT_TOOL_NAMES.insertParagraphs,
    status: "succeeded",
    output: {
      status: "success",
      diagnostics: [],
      document: docxRef,
      versionNumber: 7,
      baseVersionId: "ver-6",
      change: {
        operation: "document.insert_paragraphs",
        area: "5 paragraph(s)",
        before: "",
        after: prose,
      },
    },
  };

  assert.ok(isPersistedDocumentMutationToolResult(canonical.output));
  const projected = projectToolResultForModel(canonical);
  const output = projected.output as Record<string, unknown>;
  assert.equal(output.ok, true);
  assert.equal(output.operation, "document.insert_paragraphs");
  assert.equal(output.versionNumber, 7);
  assert.equal(output.changed, "paragraphs_inserted");
  assert.equal(output.count, 5);
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes(prose));
});

test("failure projection preserves structured diagnostics", () => {
  const projected = projectToolResultForModel({
    role: "tool",
    toolCallId: "c1",
    toolName: DOCUMENT_TOOL_NAMES.insertParagraphs,
    status: "failed",
    summary: "bad input",
    diagnostic: {
      code: "INVALID_TOOL_INPUT",
      severity: "error",
      message: "texts must be strings",
      reasonCode: "SCHEMA_INVALID",
      operation: "document.insert_paragraphs",
    },
  });
  const output = projected.output as Record<string, unknown>;
  assert.equal(output.ok, false);
  assert.equal(output.code, "INVALID_TOOL_INPUT");
  assert.equal(output.reasonCode, "SCHEMA_INVALID");
  assert.equal(output.operation, "document.insert_paragraphs");
});

test("transformContext projects tool results without mutating canonical transcript", () => {
  const prose = "UNIQUE_PROSE_SHOULD_STAY_CANONICAL";
  const canonical: ModelMessage[] = [
    { role: "user", content: "write" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: { texts: [prose], placement: { kind: "end" } },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "c1",
      toolName: DOCUMENT_TOOL_NAMES.insertParagraphs,
      status: "succeeded",
      output: {
        status: "success",
        diagnostics: [],
        document: { ...docxRef, versionId: "ver-2" },
        versionNumber: 2,
        baseVersionId: "ver-1",
        change: {
          operation: "document.insert_paragraphs",
          area: "1 paragraph(s)",
          before: "",
          after: prose,
        },
      },
    },
  ];

  const modelFacing = transformContext(canonical);
  assert.notEqual(modelFacing, canonical);
  assert.ok(
    JSON.stringify(canonical).includes(prose),
    "canonical retains prose",
  );
  assert.ok(
    !JSON.stringify(modelFacing[2]).includes(prose),
    "model-facing drops prose echo",
  );
});

test("AgentRunner sends transformed messages to the model", async () => {
  const prose = "ECHO_ME_NOT_IN_MODEL_CONTEXT";
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute(_document, operation) {
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: operation.type,
          area: "1 paragraph(s)",
          before: "",
          after: prose,
        },
        artifactBytes: new Uint8Array([1]),
      };
    },
  };
  let secondTurnMessages: readonly ModelMessage[] | undefined;

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: [prose],
            placement: { kind: "end" },
          },
        },
      ]),
      (request) => {
        secondTurnMessages = request.messages;
        return assistantOnlyResponse("done");
      },
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
    instruction: "insert",
    threadId: "t1",
    runId: "r-transform",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");
  assert.ok(secondTurnMessages);
  const toolMsg = secondTurnMessages!.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  const output = toolMsg.output as Record<string, unknown>;
  assert.equal(output.ok, true);
  assert.ok(!JSON.stringify(toolMsg).includes(prose));
  // Rich internal outcome still available on AgentResult.
  const rich = result.toolOutcomes[0]?.output;
  assert.ok(isPersistedDocumentMutationToolResult(rich));
  assert.ok(
    JSON.stringify(rich).includes(prose),
    "persisted/UI result retains change.after",
  );
});

test("telemetry records model and tool metrics without changing outcomes", async () => {
  const sink = createRecordingEventSink();
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
    model: createScriptedAgentModel([
      () => ({
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Hello world paragraph."],
              placement: { kind: "end" },
            },
          },
        ],
        meta: {
          provider: "fake",
          modelId: "fake-1",
          finishReason: "tool_calls",
          usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2 },
          latencyMs: 42,
        },
      }),
      () => ({
        content: "done",
        toolCalls: [],
        meta: {
          provider: "fake",
          modelId: "fake-1",
          finishReason: "stop",
          usage: { inputTokens: 20, outputTokens: 5 },
          latencyMs: 17,
        },
      }),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events: sink,
  });

  const result = await runner.run({
    instruction: "write",
    threadId: "t1",
    runId: "r-telemetry",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");

  const modelMetrics = sink.events.filter((e) => e.type === "model.turn.metrics");
  const toolMetrics = sink.events.filter(
    (e) => e.type === "tool.execution.metrics",
  );
  assert.equal(modelMetrics.length, 2);
  assert.equal(toolMetrics.length, 1);

  const first = modelMetrics[0]!;
  assert.equal(first.type, "model.turn.metrics");
  if (first.type === "model.turn.metrics") {
    assert.equal(first.provider, "fake");
    assert.equal(first.modelId, "fake-1");
    assert.equal(first.modelWallMs, 42);
    assert.equal(first.inputTokens, 11);
    assert.equal(first.cachedInputTokens, 2);
    assert.equal(first.outputTokens, 3);
    assert.equal(first.toolCallCount, 1);
    assert.ok(first.contextMessageBytes > 0);
    assert.ok(first.toolCatalogBytes > 0);
    assert.ok(first.toolArgumentBytes > 0);
    assert.equal(first.finishReason, "tool_calls");
  }

  const tool = toolMetrics[0]!;
  assert.equal(tool.type, "tool.execution.metrics");
  if (tool.type === "tool.execution.metrics") {
    assert.equal(tool.toolName, DOCUMENT_TOOL_NAMES.insertParagraphs);
    assert.equal(tool.success, true);
    assert.ok(tool.inputBytes > 0);
    assert.ok(tool.resultBytes > 0);
  }
});

test("system prompt with mutate caps encourages multi-tool batching", () => {
  const prompt = buildDocumentAgentSystemPrompt(mutableDocumentCapabilities());
  assert.match(prompt, /fewest MODEL ROUNDS/i);
  assert.match(prompt, /emit several small writes together in one assistant response/i);
  assert.match(prompt, /LONG-FORM/i);
  assert.match(prompt, /need no inspect before append/i);
  assert.match(prompt, /do not retry the same call unchanged/i);
  assert.match(prompt, /create_blank_docx alone/i);
  assert.match(prompt, /short Done/i);
  assert.match(prompt, /NEW DOCUMENT/i);
  assert.match(prompt, /Heading 1/i);
  assert.match(prompt, /compact first pass|compact passes/i);
  assert.match(prompt, /semantic rowLabel/i);
  assert.doesNotMatch(prompt, /Global capabilities tell you/i);
  assert.doesNotMatch(prompt, /Call document\.capabilities/i);
});

test("inspect model projection drops Set capabilities that would become empty ids", () => {
  const projected = projectToolResultForModel({
    role: "tool",
    toolCallId: "c1",
    toolName: "document.inspect",
    status: "succeeded",
    summary: JSON.stringify({
      status: "success",
      capabilities: { ids: {} },
    }),
    output: {
      status: "success",
      format: "docx",
      capabilities: createCapabilities(
        Capabilities.DocumentInspect,
        Capabilities.DocumentMutate,
      ),
      diagnostics: [],
      focus: { kind: "overview" },
      payload: {
        format: "docx",
        summary: { title: null, unitKind: "page", unitCount: 1 },
        paragraphs: [{ handle: "p0", text: "Hi", occurrence: 0 }],
      },
    },
  });
  const output = projected.output as Record<string, unknown>;
  assert.equal(output.status, "success");
  assert.equal("capabilities" in output, false);
  assert.equal("format" in output, false);
  assert.equal("diagnostics" in output, false);
  const payload = output.payload as Record<string, unknown>;
  assert.equal("format" in payload, false);
  const summary = payload.summary as Record<string, unknown>;
  assert.equal("title" in summary, false);
  assert.equal(summary.unitCount, 1);
  assert.ok(!JSON.stringify(projected).includes('"ids":{}'));
});

test("empty-caps production prompt omits mutate guidance (static bug regression)", () => {
  const prompt = buildDocumentAgentSystemPrompt();
  assert.match(prompt, /Editing is currently unavailable|mutations are currently unavailable|OpenSuite/i);
  // Without caps arg, mutate guidance must not claim editing is allowed.
  assert.doesNotMatch(prompt, /After create_blank succeeds/);
});

test("greenfield create request: auto tool choice lets model create, then forces authoring until write lands", async () => {
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
        document: {
          ...document,
          name: "Plan.docx",
          versionNumber: 1,
        },
      };
    },
  });

  const choices: Array<"auto" | "required" | undefined> = [];
  let turn = 0;
  const model = createScriptedAgentModel([
    (request) => {
      choices.push(request.toolChoice);
      turn += 1;
      // A well-behaved model follows the system prompt's "new document"
      // guidance and calls create even though tool choice is only "auto" —
      // there is no forced tool_choice on the very first, intent-unknown
      // turn (that would also fire for plain chit-chat).
      return toolCallResponse("", [
        {
          id: "c1",
          name: "workspace.create_blank_docx",
          input: { name: "Girly Downtown Content Plan.docx" },
        },
      ]);
    },
    (request) => {
      choices.push(request.toolChoice);
      turn += 1;
      assert.ok(
        request.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.insertParagraphs),
        "mutation tools available after create",
      );
      assert.ok(
        request.tools.every(
          (t) =>
            t.name === DOCUMENT_TOOL_NAMES.insertParagraph ||
            t.name === DOCUMENT_TOOL_NAMES.insertParagraphs ||
            t.name === DOCUMENT_TOOL_NAMES.createTable ||
            t.name === DOCUMENT_TOOL_NAMES.setTableCellsText ||
            t.name === DOCUMENT_TOOL_NAMES.setParagraphStyle,
        ),
        "post-create authoring catalog is narrowed",
      );
      assert.ok(
        !request.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.inspect),
        "inspect excluded until first write",
      );
      return toolCallResponse("", [
        {
          id: "c2",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: ["Title", "Intro paragraph with enough detail."],
            placement: { kind: "end" },
          },
        },
      ]);
    },
    () => {
      turn += 1;
      return assistantOnlyResponse("Created your content plan document.");
    },
  ]);

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
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  });

  const result = await runner.run({
    instruction:
      "create me a new docs with fashion content ideas and a table",
    threadId: "t1",
    runId: "r-nudge-create",
  });

  assert.equal(result.status, "completed");
  assert.ok(turn >= 3);
  assert.equal(choices[0], "auto");
  // After create, authoring turn forces tools until a mutation lands.
  assert.equal(choices[1], "required");
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === "workspace.create_blank_docx" && o.status === "succeeded",
    ),
  );
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === DOCUMENT_TOOL_NAMES.insertParagraphs &&
        o.status === "succeeded",
    ),
  );
});

test("greenfield chit-chat ('hello') completes in one turn without creating a document", async () => {
  const createTool = createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async () => {
      throw new Error("must not be called for plain chit-chat");
    },
  });

  const choices: Array<"auto" | "required" | undefined> = [];
  let turn = 0;
  const model = createScriptedAgentModel([
    (request) => {
      choices.push(request.toolChoice);
      turn += 1;
      return assistantOnlyResponse("Hi! How can I help you today?");
    },
  ]);

  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      throw new Error("unused");
    },
  };

  const runner = new AgentRunner({
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  });

  const result = await runner.run({
    instruction: "hello how are you?",
    threadId: "t1",
    runId: "r-nudge-chitchat",
  });

  assert.equal(turn, 1);
  assert.equal(choices[0], "auto");
  assert.equal(result.status, "completed");
  assert.match(result.summary, /how can i help/i);
  assert.equal(result.toolOutcomes.length, 0);
});

test("model turn timeout fails the run instead of hanging", async () => {
  const model = {
    async complete(request: ModelRequest) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return assistantOnlyResponse("too late");
    },
  };

  const runner = new AgentRunner({
    model,
    tools: ToolRegistry.create([]),
    modelTurnTimeoutMs: 50,
  });

  const result = await runner.run({
    instruction: "hi",
    threadId: "t1",
    runId: "r-timeout",
  });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /exceeded 50ms/i);
});

test("document timeout policy retries open-doc first-turn stalls, not after read/write", () => {
  const getRetryMessage =
    createDocumentAgentRunnerPolicyOptions().getModelTimeoutRetryMessage;
  // Open-doc / greenfield first turn with no tools yet → compact-pass retry.
  assert.match(getRetryMessage({ toolOutcomes: [] }) ?? "", /timed out/i);
  assert.match(getRetryMessage({ toolOutcomes: [] }) ?? "", /compact first pass/i);
  // After a successful read, do not nudge authoring tools.
  assert.equal(
    getRetryMessage({
      toolOutcomes: [
        {
          toolCallId: "read-1",
          toolName: DOCUMENT_TOOL_NAMES.inspect,
          status: "succeeded",
        },
      ],
    }),
    undefined,
  );
  // After a write landed, no further authoring-stall retry.
  assert.equal(
    getRetryMessage({
      toolOutcomes: [
        {
          toolCallId: "w1",
          toolName: DOCUMENT_TOOL_NAMES.insertParagraphs,
          status: "succeeded",
        },
      ],
    }),
    undefined,
  );
});

test("post-create authoring timeout retries once then can finish", async () => {
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
        document: {
          ...document,
          name: "Plan.docx",
          versionNumber: 1,
        },
      };
    },
  });

  let authoringAttempts = 0;
  const model = createScriptedAgentModel([
    () =>
      toolCallResponse("", [
        {
          id: "c1",
          name: "workspace.create_blank_docx",
          input: { name: "Plan.docx" },
        },
      ]),
    async (request) => {
      authoringAttempts += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return assistantOnlyResponse("stalled");
    },
    (request) => {
      authoringAttempts += 1;
      assert.match(
        request.messages.map((m) => ("content" in m ? m.content : "")).join("\n"),
        /timed out/i,
      );
      return toolCallResponse("", [
        {
          id: "c2",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: ["Title", "Short intro."],
            placement: { kind: "end" },
          },
        },
      ]);
    },
    () => assistantOnlyResponse("Document ready."),
  ]);

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
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    modelTurnTimeoutMs: 40,
  });

  const result = await runner.run({
    instruction: "create a fashion content plan doc",
    threadId: "t1",
    runId: "r-authoring-timeout-retry",
  });

  assert.equal(result.status, "completed");
  assert.equal(authoringAttempts, 2);
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === DOCUMENT_TOOL_NAMES.insertParagraphs &&
        o.status === "succeeded",
    ),
  );
});

test("open-doc long-form authoring timeout retries with compact first pass", async () => {
  let authoringAttempts = 0;
  const model = createScriptedAgentModel([
    async (request) => {
      authoringAttempts += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return assistantOnlyResponse("stalling on giant paper payload");
    },
    (request) => {
      authoringAttempts += 1;
      assert.match(
        request.messages.map((m) => ("content" in m ? m.content : "")).join("\n"),
        /compact first pass/i,
      );
      return toolCallResponse("Done — outline drafted.", [
        {
          id: "p1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: [
              "Quantum Tunneling in Thin Barriers",
              "Abstract. We outline a simple model of tunneling probabilities.",
            ],
            placement: { kind: "end" },
          },
        },
      ]);
    },
  ]);

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
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    modelTurnTimeoutMs: 40,
  });

  const result = await runner.run({
    instruction: "write a physics research paper in this doc",
    threadId: "t1",
    runId: "r-open-doc-authoring-timeout",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(authoringAttempts, 2);
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === DOCUMENT_TOOL_NAMES.insertParagraphs &&
        o.status === "succeeded",
    ),
  );
});

test("open-doc long-form authoring timeout retries with compact first pass", async () => {
  let authoringAttempts = 0;
  const model = createScriptedAgentModel([
    async (request) => {
      authoringAttempts += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return assistantOnlyResponse("stalling on giant paper payload");
    },
    (request) => {
      authoringAttempts += 1;
      assert.match(
        request.messages.map((m) => ("content" in m ? m.content : "")).join("\n"),
        /compact first pass/i,
      );
      return toolCallResponse("Done — outline drafted.", [
        {
          id: "p1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: [
              "Quantum Tunneling in Thin Barriers",
              "Abstract. We outline a simple model of tunneling probabilities.",
            ],
            placement: { kind: "end" },
          },
        },
      ]);
    },
  ]);

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
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    modelTurnTimeoutMs: 40,
  });

  const result = await runner.run({
    instruction: "write a physics research paper in this doc",
    threadId: "t1",
    runId: "r-open-doc-authoring-timeout",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(authoringAttempts, 2);
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.toolName === DOCUMENT_TOOL_NAMES.insertParagraphs &&
        o.status === "succeeded",
    ),
  );
});

test("edit follow-up after mutation allows final chat without create nudge fail", async () => {
  const createTool = createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async () => {
      throw new Error("should not create on edit follow-up");
    },
  });

  const choices: Array<"auto" | "required" | undefined> = [];
  const model = createScriptedAgentModel([
    (request) => {
      choices.push(request.toolChoice);
      return toolCallResponse("", [
        {
          id: "s1",
          name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
          input: {
            target: { text: "Downtown Sophisticated Content Plan" },
            style: "Heading 1",
          },
        },
      ]);
    },
    (request) => {
      choices.push(request.toolChoice);
      return assistantOnlyResponse("Headline styled as Heading 1.");
    },
  ]);

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
    model,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "please provide proper styling to our headline",
    threadId: "t1",
    runId: "r-edit-style",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(choices[0], "auto");
  assert.equal(choices[1], "auto");
  assert.match(result.summary, /Heading 1/i);
});

test("open-doc Q&A: after inspect, text answer completes without create-nudge failure", async () => {
  const createTool = createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async () => {
      throw new Error("must not create on paragraph Q&A");
    },
  });

  const choices: Array<"auto" | "required" | undefined> = [];
  let modelCalls = 0;
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request) => {
        modelCalls += 1;
        choices.push(request.toolChoice);
        return toolCallResponse("", [
          {
            id: "i1",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 10 } },
          },
        ]);
      },
      (request) => {
        modelCalls += 1;
        choices.push(request.toolChoice);
        return assistantOnlyResponse(
          "The second paragraph is the intro about reading regularly to grow knowledge and reduce stress.",
        );
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "What does the second paragraph say?",
    threadId: "t1",
    runId: "r-qa-paragraph",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(choices[0], "auto");
  assert.equal(choices[1], "auto");
  assert.match(result.summary, /second paragraph|intro|reading/i);
  assert.ok(
    !result.toolOutcomes.some(
      (o) => o.toolName === "workspace.create_blank_docx",
    ),
  );
});

test("v2 write-terminalization: content + successful writes finishes without third model turn", async () => {
  const versions: string[] = [];
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
        document: { ...document, name: "Report.docx", versionNumber: 1 },
      };
    },
  });

  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("", [
          {
            id: "c1",
            name: "workspace.create_blank_docx",
            input: { name: "Report.docx" },
          },
        ]);
      },
      () => {
        modelCalls += 1;
        return toolCallResponse("Done — your report is ready.", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Title", "Intro paragraph."],
              placement: { kind: "end" },
            },
          },
          {
            id: "w2",
            name: DOCUMENT_TOOL_NAMES.createTable,
            input: {
              rows: [
                ["A", "B"],
                ["1", "2"],
              ],
              placement: { kind: "end" },
            },
          },
          {
            id: "w3",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Closing."],
              placement: { kind: "end" },
            },
          },
        ]);
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("should not run");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createTool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    events: {
      async emit(event) {
        if (event.type === "document.version.advanced") {
          versions.push(event.versionId);
        }
      },
    },
  });

  const result = await runner.run({
    instruction: "create a report with a table",
    threadId: "t1",
    runId: "r-terminalize",
  });

  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(result.summary, "Done — your report is ready.");
  assert.equal(result.toolOutcomes.length, 4);
  assert.equal(versions.length, 3);
  assert.deepEqual(
    result.toolOutcomes.map((o) => o.status),
    ["succeeded", "succeeded", "succeeded", "succeeded"],
  );
});

test("v2 write-terminalization failure: optimistic content not final; model continues", async () => {
  let writes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      writes += 1;
      if (writes === 2) {
        return {
          status: "error" as const,
          code: "TARGET_NOT_FOUND" as const,
          diagnostics: [
            {
              code: "TARGET_NOT_FOUND",
              severity: "error" as const,
              message: "table missing",
            },
          ],
        };
      }
      return {
        status: "success" as const,
        diagnostics: [],
        artifactBytes: new Uint8Array([writes]),
      };
    },
  };

  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("Done — should not stick.", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Ok"],
              placement: { kind: "end" },
            },
          },
          {
            id: "w2",
            name: DOCUMENT_TOOL_NAMES.createTable,
            input: {
              rows: [["H"], ["1"]],
              placement: { kind: "end" },
            },
          },
          {
            id: "w3",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["After fail"],
              placement: { kind: "end" },
            },
          },
        ]);
      },
      (request) => {
        modelCalls += 1;
        const toolMsgs = request.messages.filter((m) => m.role === "tool");
        assert.ok(toolMsgs.length >= 2);
        assert.ok(
          toolMsgs.some(
            (m) => m.role === "tool" && m.status === "failed",
          ),
        );
        return assistantOnlyResponse("Recovered after the failed write.");
      },
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
    instruction: "write content",
    threadId: "t1",
    runId: "r-term-fail",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(result.summary, "Recovered after the failed write.");
  assert.notEqual(result.summary, "Done — should not stick.");
  assert.ok(result.toolOutcomes.some((o) => o.status === "failed"));
  // Third write still executes under existing sequential batch semantics.
  assert.equal(result.toolOutcomes.length, 3);
});

test("v2 read-only batch never terminalizes from pre-tool content", async () => {
  let modelCalls = 0;
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("Here is what I found in the doc.", [
          {
            id: "i1",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "overview" } },
          },
        ]);
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("Overview: blank-ish document.");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    instruction: "what is in this doc?",
    threadId: "t1",
    runId: "r-read-no-term",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(result.summary, "Overview: blank-ish document.");
});

test("v2 confirmation-required batch does not terminalize", async () => {
  const destructive = createFakeTool({
    name: "document.danger_wipe",
    risk: "destructive",
    effect: "write",
    executionMode: "sequential",
    execute: async () => ({ wiped: true }),
  });

  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("Done — wiped.", [
          { id: "d1", name: "document.danger_wipe", input: {} },
        ]);
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("Waiting was required; stopped.");
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("Waiting was required; stopped.");
      },
    ]),
    tools: ToolRegistry.create([destructive]),
    // denyAll confirmation gate by default → skipped / denied
  });

  const result = await runner.run({
    instruction: "wipe it",
    threadId: "t1",
    runId: "r-confirm-no-term",
  });

  assert.ok(modelCalls >= 2);
  assert.notEqual(result.summary, "Done — wiped.");
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.status === "awaiting_confirmation" || o.status === "skipped",
    ),
  );
});

test("v2 context compaction: large create_table args compacted for model, canonical retained", () => {
  const giantRows = Array.from({ length: 12 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) => `cell-${r}-${c}-padding-${"x".repeat(20)}`),
  );
  const giantInput = {
    rows: giantRows,
    placement: { kind: "end" },
  };
  assert.ok(JSON.stringify(giantInput).length > 512);

  const canonical: ModelMessage[] = [
    { role: "user", content: "make a table" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          name: DOCUMENT_TOOL_NAMES.createTable,
          input: giantInput,
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "t1",
      toolName: DOCUMENT_TOOL_NAMES.createTable,
      status: "succeeded",
      summary: "ok",
      output: {
        status: "success",
        diagnostics: [],
        document: docxRef,
        versionNumber: 2,
        baseVersionId: "ver-1",
        change: {
          operation: "document.create_table",
          area: "table",
          before: "",
          after: "",
        },
      },
    },
  ];

  const modelFacing = transformContext(canonical);
  const assistant = modelFacing[1];
  assert.ok(assistant && assistant.role === "assistant");
  const call = assistant.toolCalls?.[0];
  assert.ok(call);
  assert.equal(call.id, "t1");
  assert.equal(call.name, DOCUMENT_TOOL_NAMES.createTable);
  const compact = call.input as Record<string, unknown>;
  assert.equal(compact.executed, true);
  assert.equal(compact.rows, 12);
  assert.equal(compact.columns, 6);
  assert.ok(!JSON.stringify(call.input).includes("cell-0-0-padding"));

  // Canonical unchanged
  const original = canonical[1];
  assert.ok(original && original.role === "assistant");
  assert.deepEqual(original.toolCalls?.[0]?.input, giantInput);
});

test("architecture: greenfield create alone — no ritual inspect co-batched", async () => {
  const createTool = createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async (_input, ctx) => {
      ctx.advancePrimaryDocument?.({
        documentId: "new-doc",
        versionId: "v1",
        format: "docx",
      });
      return {
        document: {
          documentId: "new-doc",
          versionId: "v1",
          format: "docx" as const,
          name: "N.docx",
          versionNumber: 1,
        },
      };
    },
  });

  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("must not ritual-inspect blank before authoring");
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
        // Author without inspect — architecture allows blank append.
        return toolCallResponse("Done — authored without inspection.", [
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
    instruction: "create a short note",
    threadId: "t1",
    runId: "r-no-ritual-inspect",
  });

  assert.equal(result.status, "completed", result.summary);
  assert.ok(!postCreateTools.includes(DOCUMENT_TOOL_NAMES.capabilities));
  assert.ok(
    !result.toolOutcomes.some((o) => o.toolName === DOCUMENT_TOOL_NAMES.inspect),
  );
  assert.equal(result.toolOutcomes.length, 2);
});

test("architecture: sequential writes in one turn advance version between calls", async () => {
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
      () =>
        toolCallResponse("Done — two writes.", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["One"],
              placement: { kind: "end" },
            },
          },
          {
            id: "w2",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["Two"],
              placement: { kind: "end" },
            },
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
    instruction: "add two paragraphs",
    threadId: "t1",
    runId: "r-seq-versions",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(seenBaseVersions.length, 2);
  assert.equal(seenBaseVersions[0], "ver-1");
  assert.notEqual(seenBaseVersions[1], seenBaseVersions[0]);
  assert.ok(String(seenBaseVersions[1]).startsWith("ver-1"));
});

test("v4: complete manifest-backed DOCX catalog stays below 24KB", () => {
  const caps = mutableDocumentCapabilities();
  const tools = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const bytes = measureToolCatalogBytes(tools);
  // Before v4: ~22592. Keep schemas strict but drop duplicated prose.
  assert.ok(bytes < 24_000, `catalog still heavy: ${bytes}`);
  assert.ok(bytes > 8_000, `catalog suspiciously tiny: ${bytes}`);
});

test("v4: set_table_cells_text prefers semantic targets when batching writes", () => {
  const tool = listDocumentToolDescriptors().find(
    (t) => t.name === DOCUMENT_TOOL_NAMES.setTableCellsText,
  );
  assert.ok(tool);
  assert.match(tool!.description, /semantic/i);
  assert.match(tool!.description, /stale/i);
});

test("v4: mutation projection omits document/version UUIDs", () => {
  const projected = projectToolResultForModel({
    role: "tool",
    toolCallId: "c1",
    toolName: DOCUMENT_TOOL_NAMES.setParagraphStyle,
    status: "succeeded",
    output: {
      status: "success",
      document: {
        documentId: "doc-uuid",
        versionId: "ver-uuid",
        format: "docx",
      },
      versionNumber: 2,
      baseVersionId: "ver-1",
      change: {
        operation: "document.set_paragraph_style",
        area: "style",
        before: "",
        after: "Heading 1",
      },
      diagnostics: [],
    },
  });
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes("doc-uuid"));
  assert.ok(!serialized.includes("ver-uuid"));
  assert.equal((projected.output as { ok: boolean }).ok, true);
});
