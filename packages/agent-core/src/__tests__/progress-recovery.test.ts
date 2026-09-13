/**
 * One-Failure Recovery Mode v1 — deterministic cascade / retry / evidence tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  assistantOnlyResponse,
  createDocumentAgentRunnerOptions,
  createInMemoryDocumentMutationExecutor,
  createRecordingEventSink,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  toolCallResponse,
  type DocumentRuntime,
  type DocumentRef,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-recovery",
  versionId: "v1",
  format: "docx",
};

function successExecute(bytes: number) {
  return {
    status: "success" as const,
    diagnostics: [],
    artifactBytes: new Uint8Array([bytes]),
  };
}

function targetNotFoundExecute() {
  return {
    status: "error" as const,
    code: "TARGET_NOT_FOUND" as const,
    diagnostics: [
      {
        code: "TARGET_NOT_FOUND" as const,
        severity: "error" as const,
        message: "target missing",
      },
    ] as const,
  };
}

test("A: same-response failure cascade defers later mutations; A persists; recovery frame next turn", async () => {
  let writes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute() {
      writes += 1;
      if (writes === 2) return targetNotFoundExecute();
      return successExecute(writes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "a",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "A-ok", placement: { kind: "end" } },
          },
          {
            id: "b",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "B-miss", placement: { kind: "end" } },
          },
          {
            id: "c",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "C-speculative", placement: { kind: "end" } },
          },
          {
            id: "d",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "D-speculative", placement: { kind: "end" } },
          },
        ]),
      (request) => {
        const recovery = request.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            /RECOVERY MODE/i.test(m.content),
        );
        assert.equal(recovery, true);
        assert.match(
          String(
            request.messages.find(
              (m) =>
                m.role === "user" &&
                typeof m.content === "string" &&
                /RECOVERY MODE/i.test(m.content),
            ) &&
              (
                request.messages.find(
                  (m) =>
                    m.role === "user" &&
                    typeof m.content === "string" &&
                    /RECOVERY MODE/i.test(m.content),
                ) as { content: string }
              ).content,
          ),
          /TARGET_NOT_FOUND/,
        );
        return assistantOnlyResponse("Acknowledged recovery.");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events,
  });

  const result = await runner.run({
    instruction: "write cascade",
    threadId: "t-a",
    runId: "r-a",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.equal(result.toolOutcomes[1]?.status, "failed");
  assert.equal(result.toolOutcomes[1]?.diagnostic?.code, "TARGET_NOT_FOUND");
  assert.equal(result.toolOutcomes[2]?.status, "skipped");
  assert.equal(
    (result.toolOutcomes[2]?.output as { progress?: string }).progress,
    "RECOVERY_DEFERRED",
  );
  assert.equal(result.toolOutcomes[3]?.status, "skipped");
  assert.equal(
    (result.toolOutcomes[3]?.output as { progress?: string }).progress,
    "RECOVERY_DEFERRED",
  );
  assert.equal(writes, 2);
  assert.ok(
    events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_ACTIVATED",
    ),
  );
  assert.equal(
    result.toolOutcomes.filter((o) => o.status === "failed").length,
    1,
  );
});

test("B: exact failed retry is blocked without second engine failure", async () => {
  let writes = 0;
  const failInput = {
    text: "missing-target",
    placement: { kind: "end" as const },
  };
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unused");
    },
    async execute() {
      writes += 1;
      return targetNotFoundExecute();
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "f1",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: failInput,
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "f2",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: failInput,
          },
        ]),
      () => assistantOnlyResponse("Stopped exact retry."),
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
    instruction: "retry same",
    threadId: "t-b",
    runId: "r-b",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(writes, 1);
  assert.equal(result.toolOutcomes[0]?.status, "failed");
  assert.equal(result.toolOutcomes[1]?.status, "skipped");
  assert.equal(
    (result.toolOutcomes[1]?.output as { progress?: string }).progress,
    "RECOVERY_REPEAT_BLOCKED",
  );
  assert.equal(
    result.toolOutcomes.filter((o) => o.status === "failed").length,
    1,
  );
});

test("C: target recovery — inspect evidence then corrected mutation clears recovery", async () => {
  let writes = 0;
  let inspectCalls = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      inspectCalls += 1;
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        focus: { kind: "paragraphs", offset: 0, limit: 20 },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 2 },
          page: { total: 2, offset: 0, returned: 2, hasMore: false },
          paragraphs: [
            { handle: "p0", text: "Title" },
            { handle: "p1", text: "Body" },
          ],
        },
        diagnostics: [],
      };
    },
    async execute() {
      writes += 1;
      if (writes === 1) return targetNotFoundExecute();
      return successExecute(writes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "bad",
            name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
            input: { target: { text: "Nope" }, style: "Heading 1" },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "ins",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 20 } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "ok",
            name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
            input: { target: { text: "Title" }, style: "Heading 1" },
          },
        ]),
      (request) => {
        const stillRecovery = request.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            /RECOVERY MODE/i.test(m.content),
        );
        assert.equal(stillRecovery, false);
        return assistantOnlyResponse("Recovered.");
      },
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events,
  });

  const result = await runner.run({
    instruction: "fix style",
    threadId: "t-c",
    runId: "r-c",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(inspectCalls, 1);
  assert.equal(writes, 2);
  assert.ok(
    events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_EVIDENCE",
    ),
  );
  assert.ok(
    events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_CLEARED",
    ),
  );
});

test("D: stale handle activates STALE_STATE recovery and never auto-rebinds", async () => {
  let writes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        focus: { kind: "body_blocks", offset: 0, limit: 20 },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          page: { total: 1, offset: 0, returned: 1, hasMore: false },
          bodyBlocks: [{ handle: "b0", kind: "paragraph", text: "Hi" }],
        },
        diagnostics: [],
      };
    },
    async execute() {
      writes += 1;
      return {
        status: "error" as const,
        code: "STALE_HANDLE" as const,
        diagnostics: [
          {
            code: "STALE_HANDLE" as const,
            severity: "error" as const,
            message: "handle stale",
          },
        ],
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "stale",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: {
              text: "After",
              placement: { kind: "after", handle: "old-handle" },
            },
          },
        ]),
      (request) => {
        const msg = request.messages.find(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            /RECOVERY MODE/i.test(m.content),
        );
        assert.ok(msg && msg.role === "user");
        assert.match(msg.content, /STALE_HANDLE|opaque handle|semantic selector/i);
        return assistantOnlyResponse("Will refresh handles.");
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
    instruction: "stale",
    threadId: "t-d",
    runId: "r-d",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  // STALE_HANDLE is typically rejected before runtime; either way recovery activates.
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.status === "failed" &&
        (o.diagnostic?.code === "STALE_HANDLE" ||
          o.diagnostic?.code === "UNKNOWN_HANDLE"),
    ),
  );
  void writes;
});

test("E: INVALID_TOOL_INPUT allows corrected call without forced inspect", async () => {
  let writes = 0;
  let inspectCalls = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      inspectCalls += 1;
      throw new Error("should not inspect");
    },
    async execute() {
      writes += 1;
      return successExecute(writes);
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "bad",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["line\nwith\nnewlines"],
              placement: { kind: "end" },
            },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "ok",
            name: DOCUMENT_TOOL_NAMES.insertParagraphs,
            input: {
              texts: ["line one", "line two"],
              placement: { kind: "end" },
            },
          },
        ]),
      () => assistantOnlyResponse("Corrected input."),
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
    instruction: "fix input",
    threadId: "t-e",
    runId: "r-e",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes[0]?.status, "failed");
  assert.equal(result.toolOutcomes[0]?.diagnostic?.code, "INVALID_TOOL_INPUT");
  assert.equal(result.toolOutcomes[1]?.status, "succeeded");
  assert.equal(inspectCalls, 0);
  assert.equal(writes, 1);
});

test("F: redundant inspect during recovery is not recovery evidence", async () => {
  let inspectCalls = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      inspectCalls += 1;
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        focus: { kind: "paragraphs", offset: 0, limit: 20 },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 5 },
          page: { total: 5, offset: 0, returned: 5, hasMore: false },
          paragraphs: [{ handle: "p0", text: "Only" }],
        },
        diagnostics: [],
      };
    },
    async execute() {
      return targetNotFoundExecute();
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "x", placement: { kind: "end" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "i1",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 20 } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "i2",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 20 } },
          },
        ]),
      () => assistantOnlyResponse("Enough."),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events,
  });

  const result = await runner.run({
    instruction: "recover with inspect loop",
    threadId: "t-f",
    runId: "r-f",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(inspectCalls, 1);
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.status === "skipped" &&
        (o.output as { progress?: string })?.progress === "REDUNDANT_READ",
    ),
  );
  const evidenceEvents = events.events.filter(
    (e) => e.type === "agent.progress" && e.classification === "RECOVERY_EVIDENCE",
  );
  assert.equal(evidenceEvents.length, 1);
});

test("G: provider/model failure does not activate document recovery", async () => {
  const events = createRecordingEventSink();
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
    model: {
      async complete() {
        throw new Error("provider boom");
      },
    },
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events,
  });

  const result = await runner.run({
    instruction: "hello",
    threadId: "t-g",
    runId: "r-g",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "failed");
  assert.ok(
    !events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_ACTIVATED",
    ),
  );
});

test("H: partial success — earlier writes remain after first failure", async () => {
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
      if (writes >= 3) return targetNotFoundExecute();
      return successExecute(writes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "one", placement: { kind: "end" } },
          },
          {
            id: "w2",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "two", placement: { kind: "end" } },
          },
          {
            id: "w3",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "three", placement: { kind: "end" } },
          },
          {
            id: "w4",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "four", placement: { kind: "end" } },
          },
        ]),
      () => assistantOnlyResponse("Kept partial success."),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    events,
  });

  const result = await runner.run({
    instruction: "partial",
    threadId: "t-h",
    runId: "r-h",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.equal(result.toolOutcomes[1]?.status, "succeeded");
  assert.equal(result.toolOutcomes[2]?.status, "failed");
  assert.equal(result.toolOutcomes[3]?.status, "skipped");
  assert.equal(writes, 3);
  const advances = events.events.filter((e) => e.type === "document.version.advanced");
  assert.equal(advances.length, 2);
});
