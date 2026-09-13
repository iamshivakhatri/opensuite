/**
 * Progress Ledger v0 + Stagnation Guard v1 — deterministic fitness-style loop.
 * Proves identical inspect on the same version cannot burn engine turns / maxTurns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createInMemoryDocumentMutationExecutor,
  createRecordingEventSink,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  toolCallResponse,
  assistantOnlyResponse,
  type DocumentRuntime,
  type DocumentRef,
} from "../index.js";
import { createMockDocumentRuntime } from "../mock-runtime.js";

const docxRef: DocumentRef = {
  documentId: "doc-fitness-loop",
  versionId: "v1",
  format: "docx",
};

const INSPECT_PAGE = {
  focus: { kind: "paragraphs" as const, offset: 0, limit: 20 },
};

function paragraphsPayload(offset: number, limit: number, total: number) {
  const items = Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, i) => ({
    text: `Paragraph ${offset + i + 1}`,
  }));
  return {
    status: "success" as const,
    payload: {
      format: "docx" as const,
      summary: { title: null, outline: [], warnings: [] },
      page: {
        total,
        offset,
        returned: items.length,
        hasMore: offset + items.length < total,
      },
      paragraphs: items,
    },
    diagnostics: [],
  };
}

test("stagnation guard: repeated identical paragraph inspect is REDUNDANT_READ without re-executing runtime", async () => {
  let inspectCalls = 0;
  const base = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runtime: DocumentRuntime = {
    ...base,
    async inspect(document, options) {
      inspectCalls += 1;
      const focus = options.focus;
      const offset =
        focus && "offset" in focus && typeof focus.offset === "number"
          ? focus.offset
          : 0;
      const limit =
        focus && "limit" in focus && typeof focus.limit === "number"
          ? focus.limit
          : 20;
      return paragraphsPayload(offset, limit, 69);
    },
  };

  const events = createRecordingEventSink();
  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("", [
          { id: "i1", name: DOCUMENT_TOOL_NAMES.inspect, input: INSPECT_PAGE },
        ]);
      },
      (request) => {
        modelCalls += 1;
        const stagnation = request.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            /no new progress|already available/i.test(m.content),
        );
        const redundantTool = request.messages.some(
          (m) =>
            m.role === "tool" &&
            m.toolName === DOCUMENT_TOOL_NAMES.inspect &&
            m.status === "skipped" &&
            (m.output as { progress?: string } | undefined)?.progress ===
              "REDUNDANT_READ",
        );
        assert.equal(stagnation, true);
        assert.equal(redundantTool, true);
        return toolCallResponse("", [
          { id: "i2", name: DOCUMENT_TOOL_NAMES.inspect, input: INSPECT_PAGE },
        ]);
      },
      (request) => {
        modelCalls += 1;
        const redundantCount = request.messages.filter(
          (m) =>
            m.role === "tool" &&
            (m.output as { progress?: string } | undefined)?.progress ===
              "REDUNDANT_READ",
        ).length;
        assert.ok(redundantCount >= 1);
        return assistantOnlyResponse(
          "Document already inspected; here is the answer from known paragraphs.",
        );
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
    maxTurns: 20,
  });

  const result = await runner.run({
    instruction: "Summarize the workout section.",
    threadId: "t-stagnation",
    runId: "r-stagnation",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(inspectCalls, 1);
  assert.equal(modelCalls, 3);
  assert.ok(
    result.toolOutcomes.some((o) => o.status === "succeeded"),
    "first inspect succeeds with knowledge",
  );
  assert.ok(
    result.toolOutcomes.some(
      (o) =>
        o.status === "skipped" &&
        (o.output as { progress?: string } | undefined)?.progress ===
          "REDUNDANT_READ",
    ),
    "subsequent identical inspect is skipped as REDUNDANT_READ",
  );
  assert.ok(
    !result.diagnostics.some((d) => d.code === "MAX_TURNS_EXCEEDED"),
    "maxTurns is not what stopped the inspect loop",
  );

  const progress = events.events.filter((e) => e.type === "agent.progress");
  assert.ok(
    progress.some((e) => e.type === "agent.progress" && e.classification === "KNOWLEDGE_PROGRESS"),
  );
  assert.ok(
    progress.some((e) => e.type === "agent.progress" && e.classification === "REDUNDANT_READ"),
  );
  const redundant = progress.find(
    (e) => e.type === "agent.progress" && e.classification === "REDUNDANT_READ",
  );
  assert.ok(redundant && redundant.type === "agent.progress");
  assert.equal(redundant.nextOffset, 20);
});

test("stagnation guard: different offset remains knowledge progress; mutation clears and allows re-inspect", async () => {
  let inspectCalls = 0;
  const inspectedOffsets: number[] = [];
  const base = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runtime: DocumentRuntime = {
    ...base,
    async inspect(_document, options) {
      inspectCalls += 1;
      const focus = options.focus;
      const offset =
        focus && "offset" in focus && typeof focus.offset === "number"
          ? focus.offset
          : 0;
      inspectedOffsets.push(offset);
      return paragraphsPayload(offset, 20, 69);
    },
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1, 2, 3]),
      };
    },
  };

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () =>
        toolCallResponse("", [
          {
            id: "i0",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 20 } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "i20",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 20, limit: 20 } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "w1",
            name: DOCUMENT_TOOL_NAMES.insertParagraph,
            input: { text: "Cooldown note", placement: { kind: "end" } },
          },
        ]),
      () =>
        toolCallResponse("", [
          {
            id: "i0-again",
            name: DOCUMENT_TOOL_NAMES.inspect,
            input: { focus: { kind: "paragraphs", offset: 0, limit: 20 } },
          },
        ]),
      () => assistantOnlyResponse("Re-inspected after write."),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
      primaryDocument: docxRef,
    }),
    maxTurns: 20,
  });

  const result = await runner.run({
    instruction: "Inspect pages then edit.",
    threadId: "t-coverage",
    runId: "r-coverage",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(inspectedOffsets, [0, 20, 0]);
  assert.equal(inspectCalls, 3);
  assert.equal(
    result.toolOutcomes.filter((o) => o.status === "skipped").length,
    0,
  );
});

test("stagnation guard: many identical inspect turns never re-hit the engine", async () => {
  let inspectCalls = 0;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      inspectCalls += 1;
      return paragraphsPayload(0, 20, 69);
    },
    async execute() {
      throw new Error("unused");
    },
  };

  const identicalInspect = () =>
    toolCallResponse("", [
      {
        id: `i-${inspectCalls}-${Math.random()}`,
        name: DOCUMENT_TOOL_NAMES.inspect,
        input: INSPECT_PAGE,
      },
    ]);

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      identicalInspect,
      identicalInspect,
      identicalInspect,
      identicalInspect,
      identicalInspect,
      () => assistantOnlyResponse("Stopping after redundant reads."),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      primaryDocument: docxRef,
    }),
    maxTurns: 20,
  });

  const result = await runner.run({
    instruction: "Keep inspecting paragraphs.",
    threadId: "t-loop",
    runId: "r-loop",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.equal(inspectCalls, 1);
  assert.equal(
    result.toolOutcomes.filter(
      (o) =>
        o.status === "skipped" &&
        (o.output as { progress?: string } | undefined)?.progress ===
          "REDUNDANT_READ",
    ).length,
    4,
  );
  assert.ok(!result.diagnostics.some((d) => d.code === "MAX_TURNS_EXCEEDED"));
});
