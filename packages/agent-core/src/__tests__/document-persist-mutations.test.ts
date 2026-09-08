import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  createDocumentRunState,
  createDocumentToolContext,
  createDocumentToolRegistry,
  createFakeDocumentRuntime,
  createInMemoryDocumentMutationExecutor,
  createMockDocumentRuntime,
  createRecordingEventSink,
  createScriptedAgentModel,
  mutableDocumentCapabilities,
  assistantOnlyResponse,
  toolCallResponse,
  type DocumentMutationExecutor,
  type DocumentRef,
  type NonEmptyDiagnostics,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

test("same-run read-after-write: replace advances primaryDocument for next find", async () => {
  const events = createRecordingEventSink();
  const seenVersionIds: string[] = [];

  const findingRuntime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async find(document) {
      seenVersionIds.push(document.versionId);
      const text =
        document.versionId === "ver-1"
          ? "Revenue Analysis"
          : "Sales Analysis";
      return {
        status: "success",
        query: "x",
        mode: "text",
        matches: [
          {
            handle: "h1",
            excerpt: text,
            location: "paragraph",
            score: 1,
          },
        ],
        diagnostics: [],
      };
    },
    async execute(_document, operation) {
      assert.equal(operation.type, "document.replace_text");
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.replace_text",
          area: "heading",
          before: "Revenue Analysis",
          after: "Sales Analysis",
        },
        artifactBytes: new Uint8Array([1]),
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "f1",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "Revenue", mode: "text" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "Revenue Analysis", replace: "Sales Analysis" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "f2",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "Sales", mode: "text" },
        },
      ]),
      assistantOnlyResponse("Done"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime: findingRuntime,
      mutations: createInMemoryDocumentMutationExecutor(findingRuntime),
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Replace Revenue Analysis with Sales Analysis",
    threadId: "t1",
    runId: "run-raw",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(seenVersionIds, ["ver-1", "ver-1+1"]);

  const advanced = events.events.filter(
    (e) => e.type === "document.version.advanced",
  );
  assert.equal(advanced.length, 1);
  if (advanced[0]?.type === "document.version.advanced") {
    assert.equal(advanced[0].runId, "run-raw");
    assert.equal(advanced[0].documentId, "doc-docx");
    assert.equal(advanced[0].baseVersionId, "ver-1");
    assert.equal(advanced[0].versionId, "ver-1+1");
    assert.equal(advanced[0].versionNumber, 2);
  }

  // Ordering: tool.started → document.version.advanced → tool.completed (per write).
  const replaceIdx = events.events.findIndex(
    (e) =>
      e.type === "tool.started" &&
      e.toolName === DOCUMENT_TOOL_NAMES.replaceText,
  );
  const advancedIdx = events.events.findIndex(
    (e) => e.type === "document.version.advanced",
  );
  const completedIdx = events.events.findIndex(
    (e) =>
      e.type === "tool.completed" &&
      e.toolName === DOCUMENT_TOOL_NAMES.replaceText,
  );
  assert.ok(replaceIdx >= 0);
  assert.ok(advancedIdx > replaceIdx);
  assert.ok(completedIdx > advancedIdx);

  const replaceOutcome = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText,
  );
  assert.equal(replaceOutcome?.status, "succeeded");
});

test("sequential writes in one model response: one version event each, ordered", async () => {
  const events = createRecordingEventSink();
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.replace_text",
          area: "paragraph",
          before: "a",
          after: "b",
        },
        artifactBytes: new Uint8Array([1]),
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("Applied three edits.", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "A", replace: "B" },
        },
        {
          id: "r2",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "C", replace: "D" },
        },
        {
          id: "r3",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "E", replace: "F" },
        },
      ]),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Three replacements in one turn",
    threadId: "t1",
    runId: "run-seq-batch",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes.length, 3);
  assert.deepEqual(
    result.toolOutcomes.map((o) => o.status),
    ["succeeded", "succeeded", "succeeded"],
  );

  const advanced = events.events.filter(
    (e) => e.type === "document.version.advanced",
  );
  assert.equal(advanced.length, 3);
  assert.deepEqual(
    advanced.map((e) =>
      e.type === "document.version.advanced" ? e.versionId : null,
    ),
    ["ver-1+1", "ver-1+1+2", "ver-1+1+2+3"],
  );
  assert.deepEqual(
    advanced.map((e) =>
      e.type === "document.version.advanced" ? e.baseVersionId : null,
    ),
    ["ver-1", "ver-1+1", "ver-1+1+2"],
  );
  assert.deepEqual(
    advanced.map((e) =>
      e.type === "document.version.advanced" ? e.versionNumber : null,
    ),
    [2, 3, 4],
  );

  // Per write: started → version.advanced → completed, and writes are sequential.
  const relevant = events.events
    .filter((e) => {
      if (e.type === "document.version.advanced") return true;
      return (
        (e.type === "tool.started" || e.type === "tool.completed") &&
        e.toolName === DOCUMENT_TOOL_NAMES.replaceText
      );
    })
    .map((e) => e.type);
  assert.deepEqual(relevant, [
    "tool.started",
    "document.version.advanced",
    "tool.completed",
    "tool.started",
    "document.version.advanced",
    "tool.completed",
    "tool.started",
    "document.version.advanced",
    "tool.completed",
  ]);
});

test("multi-mutation run advances N → N+1 → N+2", async () => {
  const events = createRecordingEventSink();
  const baseVersions: string[] = [];
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.replace_text",
          area: "paragraph",
          before: "a",
          after: "b",
        },
        artifactBytes: new Uint8Array([1]),
      };
    },
  });
  const mutations = createInMemoryDocumentMutationExecutor(runtime);
  const trackingMutations: DocumentMutationExecutor = {
    ...mutations,
    async replaceText(input) {
      baseVersions.push(input.document.versionId);
      return mutations.replaceText(input);
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "A", replace: "B" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "r2",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "C", replace: "D" },
        },
      ]),
      assistantOnlyResponse("Both edits applied"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: trackingMutations,
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Two replacements",
    threadId: "t1",
    runId: "run-multi",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(baseVersions, ["ver-1", "ver-1+1"]);
  assert.equal(
    events.events.filter((e) => e.type === "document.version.advanced").length,
    2,
  );
  assert.ok(
    result.toolOutcomes.every(
      (o) =>
        o.toolName !== DOCUMENT_TOOL_NAMES.replaceText ||
        o.status === "succeeded",
    ),
  );
});

test("TARGET_NOT_FOUND does not advance primaryDocument", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const events = createRecordingEventSink();

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "DOES_NOT_EXIST", replace: "X" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "f1",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "Revenue", mode: "text" },
        },
      ]),
      assistantOnlyResponse("failed then found"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Try missing replace",
    threadId: "t1",
    runId: "run-miss",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  const replace = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText,
  );
  assert.equal(replace?.status, "failed");
  assert.equal(
    events.events.some((e) => e.type === "document.version.advanced"),
    false,
  );
});

test("VERSION_CONFLICT does not advance active DocumentRef", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const events = createRecordingEventSink();
  const conflictMutations: DocumentMutationExecutor = {
    ...createInMemoryDocumentMutationExecutor(runtime),
    async replaceText() {
      const diagnostics: NonEmptyDiagnostics = [
        {
          code: "VERSION_CONFLICT",
          severity: "error",
          message: "Document was updated",
        },
      ];
      return {
        status: "error",
        code: "VERSION_CONFLICT",
        diagnostics,
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "Revenue Analysis", replace: "Sales Analysis" },
        },
      ]),
      assistantOnlyResponse("conflict"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: conflictMutations,
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Conflict",
    threadId: "t1",
    runId: "run-conflict",
    primaryDocument: docxRef,
  });

  assert.equal(
    result.toolOutcomes.find(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText,
    )?.status,
    "failed",
  );
  assert.equal(
    events.events.some((e) => e.type === "document.version.advanced"),
    false,
  );
});

test("persistence failure fails the tool without advancing", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const events = createRecordingEventSink();
  const failing: DocumentMutationExecutor = {
    ...createInMemoryDocumentMutationExecutor(runtime),
    async replaceText() {
      const diagnostics: NonEmptyDiagnostics = [
        {
          code: "STORAGE_OBJECT_MISSING",
          severity: "error",
          message: "Could not persist",
        },
      ];
      return {
        status: "error",
        code: "STORAGE_OBJECT_MISSING",
        diagnostics,
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "Revenue Analysis", replace: "Sales Analysis" },
        },
      ]),
      assistantOnlyResponse("persist failed"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: failing,
    }),
    events,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "Persist fail",
    threadId: "t1",
    runId: "run-persist-fail",
    primaryDocument: docxRef,
  });

  assert.equal(
    result.toolOutcomes.find(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText,
    )?.status,
    "failed",
  );
  assert.equal(
    events.events.some((e) => e.type === "document.version.advanced"),
    false,
  );
});

test("one replace_text tool call executes engine once via mutations", async () => {
  let executeCount = 0;
  const runtime = createFakeDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
    async execute() {
      executeCount += 1;
      return {
        status: "success",
        diagnostics: [],
        change: {
          operation: "document.replace_text",
          area: "paragraph",
          before: "a",
          after: "b",
        },
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "a", replace: "b" },
        },
      ]),
      assistantOnlyResponse("ok"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    capabilities: mutableDocumentCapabilities(),
  });

  await runner.run({
    instruction: "replace",
    threadId: "t1",
    runId: "run-once",
    primaryDocument: docxRef,
  });

  assert.equal(executeCount, 1);
});

test("replace_text without mutations configured fails", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "Revenue Analysis", replace: "X" },
        },
      ]),
      assistantOnlyResponse("no mutations"),
    ]),
    tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
    }),
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "replace",
    threadId: "t1",
    runId: "run-no-mut",
    primaryDocument: docxRef,
  });

  assert.equal(
    result.toolOutcomes.find(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText,
    )?.status,
    "failed",
  );
});
