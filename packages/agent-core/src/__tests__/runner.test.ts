import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  AgentRunner,
  InMemorySteeringQueue,
  ToolRegistry,
  assistantOnlyResponse,
  createFakeAgentModel,
  createFakeTool,
  createRecordingEventSink,
  createScriptedAgentModel,
  createScriptedConfirmationGate,
  delay,
  denyAllConfirmationGate,
  toolCallResponse,
  type AgentRequest,
  type ModelMessage,
  type ModelRequest,
} from "../index.js";


function baseRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    instruction: "Do the task",
    threadId: "thread-1",
    runId: "run-1",
    ...overrides,
  };
}

function eventTypes(events: { type: string }[]): string[] {
  return events.map((event) => event.type);
}

test("BASIC: user request → model final response", async () => {
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([assistantOnlyResponse("All done.")]),
    tools: ToolRegistry.create([]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "All done.");
  assert.deepEqual(result.toolOutcomes, []);
  assert.deepEqual(eventTypes(sink.events), [
    "agent.started",
    "turn.started",
    "message.started",
    "message.delta",
    "message.completed",
    "turn.completed",
    "agent.completed",
  ]);
});

test("STREAM: onTextDelta emits message.delta chunks", async () => {
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createFakeAgentModel({
      respond: { content: "Hello streaming world from OpenSuite", toolCalls: [] },
    }),
    tools: ToolRegistry.create([]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  const deltas = sink.events.filter((e) => e.type === "message.delta");
  assert.ok(deltas.length >= 2);
  const joined = deltas
    .map((e) => (e.type === "message.delta" ? e.delta : ""))
    .join("");
  assert.equal(joined, "Hello streaming world from OpenSuite");
});

test("BASIC: one tool call → result → model completion", async () => {
  const sink = createRecordingEventSink();
  const inspect = createFakeTool({
    name: "document.inspect",
    async execute() {
      return { summary: "1 page" };
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("Inspecting…", [
        { id: "c1", name: "document.inspect", input: {} },
      ]),
      assistantOnlyResponse("Looks good."),
    ]),
    tools: ToolRegistry.create([inspect]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Looks good.");
  assert.equal(result.toolOutcomes.length, 1);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.ok(eventTypes(sink.events).includes("tool.started"));
  assert.ok(eventTypes(sink.events).includes("tool.completed"));
});

test("BASIC: multiple turns", async () => {
  let turns = 0;
  const tool = createFakeTool({
    name: "document.inspect",
    async execute() {
      return { n: turns };
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        turns += 1;
        return toolCallResponse(`turn ${turns}`, [
          { id: `c${turns}`, name: "document.inspect", input: {} },
        ]);
      },
      () => {
        turns += 1;
        return toolCallResponse(`turn ${turns}`, [
          { id: `c${turns}`, name: "document.inspect", input: {} },
        ]);
      },
      assistantOnlyResponse("Finished after 2 tools"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: createRecordingEventSink(),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes.length, 2);
  assert.equal(result.summary, "Finished after 2 tools");
});

test("TOOLS: multiple tool calls in one turn", async () => {
  const names: string[] = [];
  const a = createFakeTool({
    name: "research.a",
    executionMode: "parallel-safe",
    async execute() {
      names.push("a");
      return "A";
    },
  });
  const b = createFakeTool({
    name: "research.b",
    executionMode: "parallel-safe",
    async execute() {
      names.push("b");
      return "B";
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "research.a", input: {} },
        { id: "2", name: "research.b", input: {} },
      ]),
      assistantOnlyResponse("ok"),
    ]),
    tools: ToolRegistry.create([a, b]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.toolOutcomes.length, 2);
  assert.deepEqual(
    result.toolOutcomes.map((outcome) => outcome.toolCallId),
    ["1", "2"],
  );
});

test("TOOLS: unknown tool becomes structured failure and model can continue", async () => {
  let sawToolFailure = false;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "x", name: "nonexistent.tool", input: {} },
      ]),
      (request) => {
        const toolMsg = request.messages.find(
          (message) => message.role === "tool",
        );
        assert.ok(toolMsg && toolMsg.role === "tool");
        assert.equal(toolMsg.status, "failed");
        assert.equal(toolMsg.diagnostic?.code, "UNKNOWN_TOOL");
        sawToolFailure = true;
        return assistantOnlyResponse("I could not use that tool.");
      },
    ]),
    tools: ToolRegistry.create([]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes[0]?.status, "failed");
  assert.equal(result.toolOutcomes[0]?.diagnostic?.code, "UNKNOWN_TOOL");
  assert.equal(sawToolFailure, true);
});

test("TOOLS: invalid tool input does not execute", async () => {
  let executed = false;
  const tool = createFakeTool({
    name: "document.replace_text",
    parseInput() {
      throw new AgentCoreError("INVALID_TOOL_INPUT", "missing target");
    },
    async execute() {
      executed = true;
      return null;
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "document.replace_text", input: {} },
      ]),
      assistantOnlyResponse("fixed"),
    ]),
    tools: ToolRegistry.create([tool]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(executed, false);
  assert.equal(result.toolOutcomes[0]?.diagnostic?.code, "INVALID_TOOL_INPUT");
});

test("TOOLS: tool failure is fed back; earlier successes survive", async () => {
  const ok = createFakeTool({
    name: "research.ok",
    async execute() {
      return { summary: "ok-result" };
    },
  });
  const bad = createFakeTool({
    name: "research.bad",
    async execute() {
      throw new Error("boom");
    },
  });
  let observed: ModelMessage[] = [];
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "a", name: "research.ok", input: {} },
        { id: "b", name: "research.bad", input: {} },
      ]),
      (request) => {
        observed = [...request.messages];
        return assistantOnlyResponse("Partial progress saved.");
      },
    ]),
    tools: ToolRegistry.create([ok, bad]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.equal(result.toolOutcomes[1]?.status, "failed");
  const toolMsgs = observed.filter((message) => message.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0]?.role === "tool" && toolMsgs[0].status, "succeeded");
  assert.equal(toolMsgs[1]?.role === "tool" && toolMsgs[1].status, "failed");
});

test("PARALLELISM: parallel-safe tools overlap; order preserved", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const make = (name: string) =>
    createFakeTool({
      name,
      executionMode: "parallel-safe",
      async execute(_input, ctx) {
        starts.push(Date.now());
        await delay(40, ctx.signal);
        ends.push(Date.now());
        return name;
      },
    });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "research.a", input: {} },
        { id: "2", name: "research.b", input: {} },
      ]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([make("research.a"), make("research.b")]),
  });

  const result = await runner.run(baseRequest());
  assert.deepEqual(
    result.toolOutcomes.map((outcome) => outcome.output),
    ["research.a", "research.b"],
  );
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! < ends[0]!, "second tool started before first finished");
});

test("PARALLELISM: sequential tool is a barrier", async () => {
  const log: string[] = [];
  const parallel = createFakeTool({
    name: "research.a",
    executionMode: "parallel-safe",
    async execute() {
      log.push("a-start");
      await delay(30);
      log.push("a-end");
      return "a";
    },
  });
  const sequential = createFakeTool({
    name: "document.replace_text",
    executionMode: "sequential",
    async execute() {
      log.push("seq");
      return "seq";
    },
  });
  const after = createFakeTool({
    name: "research.b",
    executionMode: "parallel-safe",
    async execute() {
      log.push("b");
      return "b";
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "research.a", input: {} },
        { id: "2", name: "document.replace_text", input: {} },
        { id: "3", name: "research.b", input: {} },
      ]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([parallel, sequential, after]),
  });

  await runner.run(baseRequest());
  const seqIndex = log.indexOf("seq");
  const aEnd = log.indexOf("a-end");
  const bIndex = log.indexOf("b");
  assert.ok(aEnd < seqIndex);
  assert.ok(seqIndex < bIndex);
});

test("CONFIRMATION: safe tool executes immediately", async () => {
  let executed = false;
  const tool = createFakeTool({
    name: "document.replace_text",
    risk: "safe",
    async execute() {
      executed = true;
      return true;
    },
  });
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "document.replace_text", input: {} },
      ]),
      assistantOnlyResponse("ok"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
    confirmation: denyAllConfirmationGate,
  });

  await runner.run(baseRequest());
  assert.equal(executed, true);
  assert.equal(
    eventTypes(sink.events).includes("confirmation.required"),
    false,
  );
});

test("CONFIRMATION: destructive tool requires confirmation; approved executes", async () => {
  let executed = false;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executed = true;
      return true;
    },
  });
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "slides.delete_slide", input: { index: 0 } },
      ]),
      assistantOnlyResponse("deleted"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
    confirmation: createScriptedConfirmationGate([true]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(executed, true);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.ok(eventTypes(sink.events).includes("confirmation.required"));
});

test("CONFIRMATION: denied destructive tool does not execute", async () => {
  let executed = false;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executed = true;
      return true;
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "slides.delete_slide", input: {} },
      ]),
      assistantOnlyResponse("skipped delete"),
    ]),
    tools: ToolRegistry.create([tool]),
    confirmation: denyAllConfirmationGate,
  });

  const result = await runner.run(baseRequest());
  assert.equal(executed, false);
  assert.equal(result.toolOutcomes[0]?.status, "skipped");
  assert.equal(
    result.toolOutcomes[0]?.diagnostic?.code,
    "CONFIRMATION_DENIED",
  );
});

test("CONFIRMATION: no gate defaults to deny for destructive tools", async () => {
  let executed = false;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executed = true;
      return true;
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "slides.delete_slide", input: {} },
      ]),
      assistantOnlyResponse("denied by default"),
    ]),
    tools: ToolRegistry.create([tool]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(executed, false);
  assert.equal(result.toolOutcomes[0]?.status, "skipped");
  assert.equal(
    result.toolOutcomes[0]?.diagnostic?.code,
    "CONFIRMATION_DENIED",
  );
});

test("CONTEXT: priorMessages precede current instruction without duplication", async () => {
  let observed: ModelMessage[] = [];
  const runner = new AgentRunner({
    model: createFakeAgentModel({
      respond(request) {
        observed = [...request.messages];
        return assistantOnlyResponse("ok");
      },
    }),
    tools: ToolRegistry.create([]),
  });

  await runner.run(
    baseRequest({
      instruction: "third",
      priorMessages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    }),
  );

  assert.deepEqual(
    observed.filter((m) => m.role === "user" || m.role === "assistant"),
    [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ],
  );
});

test("CANCELLATION: abort before model", async () => {
  const controller = new AbortController();
  controller.abort();
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([assistantOnlyResponse("nope")]),
    tools: ToolRegistry.create([]),
    events: sink,
  });

  const result = await runner.run(baseRequest(), { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.ok(eventTypes(sink.events).includes("agent.cancelled"));
  assert.equal(eventTypes(sink.events).includes("agent.completed"), false);
});

test("CANCELLATION: abort during tool execution", async () => {
  const controller = new AbortController();
  const tool = createFakeTool({
    name: "research.slow",
    async execute(_input, ctx) {
      const wait = delay(200, ctx.signal);
      setTimeout(() => controller.abort(), 20);
      await wait;
      return "done";
    },
  });
  const sink = createRecordingEventSink();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "1", name: "research.slow", input: {} }]),
      assistantOnlyResponse("should not reach"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest(), { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.ok(eventTypes(sink.events).includes("agent.cancelled"));
});

test("STEERING: message drained before next model turn", async () => {
  const steering = new InMemorySteeringQueue();
  const seen: string[] = [];
  const tool = createFakeTool({
    name: "document.inspect",
    async execute() {
      steering.push({ content: "No, use FY2026 numbers instead." });
      return { ok: true };
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "1", name: "document.inspect", input: {} },
      ]),
      (request: ModelRequest) => {
        for (const message of request.messages) {
          if (message.role === "user") {
            seen.push(message.content);
          }
        }
        return assistantOnlyResponse("Updated to FY2026.");
      },
    ]),
    tools: ToolRegistry.create([tool]),
    steering,
  });

  const result = await runner.run(
    baseRequest({ instruction: "Update FY2025 references" }),
  );
  assert.equal(result.status, "completed");
  assert.ok(seen.includes("Update FY2025 references"));
  assert.ok(seen.includes("No, use FY2026 numbers instead."));
  assert.equal(steering.size, 0);
});

test("EVENTS: tool.failed and agent.failed on model error", async () => {
  const sink = createRecordingEventSink();
  const tool = createFakeTool({
    name: "research.bad",
    async execute() {
      throw new Error("tool boom");
    },
  });
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "1", name: "research.bad", input: {} }]),
      () => {
        throw new AgentCoreError("MODEL_FAILURE", "model exploded");
      },
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "failed");
  assert.equal(result.toolOutcomes[0]?.status, "failed");
  assert.ok(eventTypes(sink.events).includes("tool.failed"));
  assert.ok(eventTypes(sink.events).includes("agent.failed"));
});

test("LIMITS: maxTurns prevents infinite loop", async () => {
  const sink = createRecordingEventSink();
  const tool = createFakeTool({
    name: "document.inspect",
    async execute() {
      return {};
    },
  });
  const runner = new AgentRunner({
    maxTurns: 2,
    model: createFakeAgentModelAlwaysTool(tool.name),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "MAX_TURNS_EXCEEDED",
    ),
  );
  assert.equal(result.toolOutcomes.length, 2);
  assert.ok(eventTypes(sink.events).includes("agent.failed"));
});

function createFakeAgentModelAlwaysTool(toolName: string) {
  return createScriptedAgentModel(
    Array.from({ length: 50 }, (_, index) =>
      toolCallResponse("again", [
        { id: `c${index}`, name: toolName, input: {} },
      ]),
    ),
  );
}
