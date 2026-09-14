/**
 * Recovery Preflight v1 — validate recovery candidates against temporary bytes
 * before another normal durable tool failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  MAX_DISTINCT_PREFLIGHT_REJECTIONS,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createInMemoryDocumentMutationExecutor,
  createRecordingEventSink,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  toolCallResponse,
  assistantOnlyResponse,
  type DocumentMutationExecutor,
  type DocumentRuntime,
  type DocumentRef,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-preflight",
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

function targetNotFound(message = "target missing") {
  return {
    status: "error" as const,
    code: "TARGET_NOT_FOUND" as const,
    diagnostics: [
      {
        code: "TARGET_NOT_FOUND" as const,
        severity: "error" as const,
        message,
      },
    ] as const,
  };
}

function unsupportedOp(message = "not supported") {
  return {
    status: "error" as const,
    code: "UNSUPPORTED_OPERATION" as const,
    diagnostics: [
      {
        code: "UNSUPPORTED_OPERATION" as const,
        severity: "error" as const,
        message,
      },
    ] as const,
  };
}

test("A: one real failure then invalid recovery candidate → RECOVERY_PREFLIGHT_REJECTED, no second tool.failed", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute(_doc, op) {
      executes += 1;
      if (op.type === "document.delete_paragraph") return targetNotFound();
      return successExecute(executes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "missing-A" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "bad-recovery",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "missing-B" } },
          },
        ]),
      () => assistantOnlyResponse("Done — stopped after recovery preflight."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    runId: "preflight-a",
    threadId: "t1",
    instruction: "delete paragraphs",
  });

  const failed = events.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 1, "only the first real failure emits tool.failed");
  assert.equal(
    failed[0] && "diagnostic" in failed[0] ? failed[0].diagnostic.code : null,
    "TARGET_NOT_FOUND",
  );

  const outcomes = result.toolOutcomes ?? [];
  const preflightSkip = outcomes.find(
    (o) =>
      o.status === "skipped" &&
      (o.output as { progress?: string })?.progress ===
        "RECOVERY_PREFLIGHT_REJECTED",
  );
  assert.ok(preflightSkip, "recovery candidate skipped as RECOVERY_PREFLIGHT_REJECTED");
  assert.equal(
    (preflightSkip!.output as { code: string }).code,
    "TARGET_NOT_FOUND",
  );

  const versions = events.events.filter((e) => e.type === "document.version.advanced");
  assert.equal(versions.length, 0, "no version advance on preflight reject");

  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_REJECTED",
    ),
  );
  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" && e.classification === "RECOVERY_ACTIVATED",
    ),
  );
  assert.equal(executes, 2, "first failure + one preflight execute");
});

test("B: invalid then valid recovery → one real failure, promote B, clear recovery", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute(_doc, op) {
      executes += 1;
      const text =
        op.type === "document.delete_paragraph"
          ? String((op.payload as { target?: { text?: string } }).target?.text ?? "")
          : "";
      if (text === "missing" || text === "still-missing") return targetNotFound(text);
      return successExecute(executes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "missing" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "bad",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "still-missing" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "ok",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "recovered", placement: { kind: "end" } },
          },
        ]),
      () => assistantOnlyResponse("Done — recovered."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-b",
    threadId: "t1",
    instruction: "fix then recover",
  });

  const failed = events.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 1);

  const versions = events.events.filter((e) => e.type === "document.version.advanced");
  assert.equal(versions.length, 1, "only successful recovery promotes a version");

  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_REJECTED",
    ),
  );
  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_PROMOTED",
    ),
  );
  assert.ok(
    events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_CLEARED",
    ),
  );
});

test("C: successful preflight uses executeWithBytes once — no double engine execute", async () => {
  let executeCalls = 0;
  let executeWithBytesCalls = 0;
  let bytes = new Uint8Array([1]);
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute() {
      executeCalls += 1;
      return targetNotFound();
    },
    async loadBytes() {
      return bytes;
    },
    async executeWithBytes(_doc, _op, working) {
      executeWithBytesCalls += 1;
      const next = new Uint8Array([...working, 9]);
      bytes = next;
      return {
        status: "success" as const,
        diagnostics: [],
        artifactBytes: next,
      };
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "gone" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "ok",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "fixed", placement: { kind: "end" } },
          },
        ]),
      () => assistantOnlyResponse("Done — promoted."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-c",
    threadId: "t1",
    instruction: "recover once",
  });

  assert.equal(executeCalls, 1, "only the initial real failure uses execute");
  assert.equal(
    executeWithBytesCalls,
    1,
    "successful recovery validates once via executeWithBytes",
  );
  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_PROMOTED" &&
        e.bytesPromoted === true,
    ),
  );
});

test("D: stale handle during recovery is controlled preflight rejection, not second hard failure", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      return {
        status: "success" as const,
        format: "docx" as const,
        capabilities: mutableDocumentCapabilities(),
        focus: { kind: "body_blocks" as const, offset: 0, limit: 20 },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          page: { total: 1, offset: 0, returned: 1, hasMore: false },
          bodyBlocks: [{ handle: "h-fresh", kind: "paragraph", text: "Hello" }],
        },
        diagnostics: [],
      };
    },
    async execute() {
      executes += 1;
      if (executes === 1) return targetNotFound();
      return successExecute(executes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "missing" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "inspect",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "body_blocks" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "stale",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: {
              text: "after stale",
              placement: { kind: "after", handle: "h-stale" },
            },
          },
        ]),
      () => assistantOnlyResponse("Done — stale blocked."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    runId: "preflight-d",
    threadId: "t1",
    instruction: "stale during recovery",
  });

  const failed = events.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 1, "stale does not add a second tool.failed");

  const skipped = (result.toolOutcomes ?? []).find(
    (o) =>
      o.toolCallId === "stale" &&
      o.status === "skipped" &&
      ((o.output as { progress?: string })?.progress ===
        "RECOVERY_PREFLIGHT_REJECTED" ||
        (o.output as { code?: string })?.code === "STALE_HANDLE" ||
        (o.output as { code?: string })?.code === "UNKNOWN_HANDLE"),
  );
  assert.ok(skipped, "stale handle yields controlled preflight rejection");
  assert.equal(executes, 1, "stale rejected before runtime");
});

test("E: UNSUPPORTED_OPERATION during recovery is controlled rejection with diagnostics", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute(_doc, op) {
      executes += 1;
      if (executes === 1) return targetNotFound();
      if (op.type === "document.create_table") return unsupportedOp("tables off");
      return successExecute(executes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "x" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "unsupported",
            name: DOCUMENT_TOOL_NAMES.createTable,
            input: {
              rows: [["a", "b"]],
              placement: { kind: "end" },
            },
          },
        ]),
      () => assistantOnlyResponse("Done — unsupported noted."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    runId: "preflight-e",
    threadId: "t1",
    instruction: "unsupported recovery",
  });

  assert.equal(events.events.filter((e) => e.type === "tool.failed").length, 1);
  const skip = (result.toolOutcomes ?? []).find(
    (o) =>
      o.status === "skipped" &&
      (o.output as { progress?: string })?.progress ===
        "RECOVERY_PREFLIGHT_REJECTED" &&
      (o.output as { code?: string })?.code === "UNSUPPORTED_OPERATION",
  );
  assert.ok(skip);
  assert.ok(
    Array.isArray((skip!.output as { diagnostics?: unknown[] }).diagnostics),
  );
});

test("F: persistence failure after successful preflight is real infrastructure failure", async () => {
  let executeCalls = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute() {
      executeCalls += 1;
      if (executeCalls === 1) return targetNotFound();
      return successExecute(executeCalls);
    },
  };

  const base = createInMemoryDocumentMutationExecutor(runtime);
  const mutations: DocumentMutationExecutor = {
    ...base,
    async preflightMutate(input) {
      const result = await base.preflightMutate!(input);
      if (result.status === "success") {
        return {
          status: "error",
          code: "STORAGE_OBJECT_MISSING",
          diagnostics: [
            {
              code: "STORAGE_OBJECT_MISSING",
              severity: "error",
              message: "object storage append failed",
            },
          ],
        };
      }
      return result;
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "x" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "persist-fail",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "ok-but-persist-fails", placement: { kind: "end" } },
          },
        ]),
      () => assistantOnlyResponse("Done — infra failed."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations,
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-f",
    threadId: "t1",
    instruction: "persist fail",
  });

  const failed = events.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 2);
  assert.equal(
    failed[1] && "diagnostic" in failed[1] ? failed[1].diagnostic.code : null,
    "STORAGE_OBJECT_MISSING",
  );
  assert.ok(
    !events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_REJECTED" &&
        e.failureCode === "STORAGE_OBJECT_MISSING",
    ),
  );
});

test("G: exact repeated preflight candidate is blocked without re-running runtime", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute(_doc, op) {
      executes += 1;
      if (op.type === "document.delete_paragraph") return targetNotFound();
      return successExecute(executes);
    },
  };

  const sameInput = { target: { text: "still-gone" } };
  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fail1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "first" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "rej1",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: sameInput,
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "rej2",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: sameInput,
          },
        ]),
      () => assistantOnlyResponse("Done — repeat blocked."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-g",
    threadId: "t1",
    instruction: "repeat preflight",
  });

  // 1 real failure + 1 distinct preflight rejection; exact repeat blocked in beforeTool.
  assert.equal(executes, 2);
  assert.ok(
    events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        e.classification === "RECOVERY_PREFLIGHT_REJECTED" &&
        e.exactRepeatBlocked === true,
    ),
  );
});

test("H: bounded distinct preflight rejections exhaust recovery without maxTurns", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute(_doc, op) {
      executes += 1;
      if (op.type === "document.delete_paragraph") return targetNotFound();
      return successExecute(executes);
    },
  };

  const scripts = [
    () =>
      toolCallResponse("", [
        {
          id: "fail1",
          name: DOCUMENT_TOOL_NAMES.deleteParagraph,
          input: { target: { text: "seed" } },
        },
      ]),
  ];
  for (let i = 0; i < MAX_DISTINCT_PREFLIGHT_REJECTIONS + 2; i += 1) {
    const n = i;
    scripts.push(() =>
      toolCallResponse("", [
        {
          id: `rej-${n}`,
          name: DOCUMENT_TOOL_NAMES.deleteParagraph,
          input: { target: { text: `miss-${n}` } },
        },
      ]),
    );
  }
  scripts.push(() => assistantOnlyResponse("Partial — recovery exhausted."));

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel(scripts),
    events,
    maxTurns: 40,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  const result = await runner.run({
    runId: "preflight-h",
    threadId: "t1",
    instruction: "bounded recovery",
  });

  assert.equal(events.events.filter((e) => e.type === "tool.failed").length, 1);
  assert.ok(
    events.events.some(
      (e) => e.type === "agent.progress" && e.classification === "RECOVERY_EXHAUSTED",
    ),
  );
  assert.ok(
    (result.toolOutcomes ?? []).some(
      (o) =>
        o.status === "skipped" &&
        ((o.output as { progress?: string })?.progress === "RECOVERY_EXHAUSTED" ||
          (o.output as { exhausted?: boolean })?.exhausted === true),
    ),
  );
  // 1 real + MAX_DISTINCT preflights; later candidates skipped without execute.
  assert.equal(executes, 1 + MAX_DISTINCT_PREFLIGHT_REJECTIONS);
  assert.notEqual(result.status, "failed");
});

test("I: ordinary successful mutation outside recovery is unchanged", async () => {
  let executes = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute() {
      executes += 1;
      return successExecute(executes);
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "ok",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "hello", placement: { kind: "end" } },
          },
        ]),
      () => assistantOnlyResponse("Done — wrote hello."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-i",
    threadId: "t1",
    instruction: "normal write",
  });

  assert.equal(events.events.filter((e) => e.type === "tool.failed").length, 0);
  assert.equal(
    events.events.filter((e) => e.type === "document.version.advanced").length,
    1,
  );
  assert.ok(
    !events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        String(e.classification).startsWith("RECOVERY_PREFLIGHT"),
    ),
  );
  assert.equal(executes, 1);
});

test("J: formatting-session path still batches without recovery preflight interference", async () => {
  let executeWithBytes = 0;
  let appendViaExecute = 0;
  let bytes = new Uint8Array([1]);
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("unexpected inspect");
    },
    async execute() {
      appendViaExecute += 1;
      return successExecute(appendViaExecute);
    },
    async loadBytes() {
      return bytes;
    },
    async executeWithBytes(_d, _o, working) {
      executeWithBytes += 1;
      const next = new Uint8Array([...working, executeWithBytes]);
      bytes = next;
      return {
        status: "success" as const,
        diagnostics: [],
        artifactBytes: next,
      };
    },
  };

  // In-memory executor does not implement formatting sessions; use a thin
  // session-like wrapper matching production batching semantics for this guard.
  const base = createInMemoryDocumentMutationExecutor(runtime);
  let pending = false;
  const mutations: DocumentMutationExecutor = {
    ...base,
    async setParagraphStyle(input) {
      pending = true;
      const r = await runtime.executeWithBytes!(
        input.document,
        {
          type: "document.set_paragraph_style",
          baseVersionId: input.document.versionId,
          payload: { target: input.target, style: input.style },
        },
        bytes,
      );
      if (r.status === "error") {
        return { status: "error", code: r.code, diagnostics: r.diagnostics };
      }
      bytes = new Uint8Array(r.artifactBytes!);
      return {
        status: "pending",
        operation: "document.set_paragraph_style",
        diagnostics: r.diagnostics,
      };
    },
    async deleteParagraph(input) {
      pending = true;
      const r = await runtime.executeWithBytes!(
        input.document,
        { type: "document.delete_paragraph", baseVersionId: input.document.versionId, payload: { target: input.target } },
        bytes,
      );
      if (r.status === "error") return { status: "error", code: r.code, diagnostics: r.diagnostics };
      bytes = new Uint8Array(r.artifactBytes!);
      return { status: "pending", operation: "document.delete_paragraph", diagnostics: r.diagnostics };
    },
    async flushPendingFormatting() {
      if (!pending) return { status: "noop" as const };
      pending = false;
      const flushed = await base.insertParagraph({
        document: docxRef,
        text: "flush-marker",
        placement: { kind: "end" },
      });
      if (flushed.status === "pending") throw new Error("in-memory flush must persist");
      return flushed;
    },
  };

  const events = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "fmt1",
            name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
            input: { target: { text: "Title" }, style: "Heading1" },
          },
          {
            id: "fmt2",
            name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
            input: { target: { text: "Body" }, style: "Normal" },
          },
          {
            id: "delete",
            name: DOCUMENT_TOOL_NAMES.deleteParagraph,
            input: { target: { text: "Remove me" } },
          },
        ]),
      () => assistantOnlyResponse("Done — formatted."),
    ]),
    events,
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations,
      primaryDocument: docxRef,
    }),
  });

  await runner.run({
    runId: "preflight-j",
    threadId: "t1",
    instruction: "format batch",
  });

  assert.equal(executeWithBytes, 3, "formatting and structural ops use one working-byte chain");
  assert.equal(appendViaExecute, 1, "one durable flush promote");
  assert.ok(
    !events.events.some(
      (e) =>
        e.type === "agent.progress" &&
        String(e.classification).startsWith("RECOVERY_PREFLIGHT"),
    ),
  );
});
