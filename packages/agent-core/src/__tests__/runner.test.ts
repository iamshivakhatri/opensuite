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
  type AgentEvent,
  type AgentEventSink,
  type AgentRequest,
  type ModelMessage,
  type ModelRequest,
} from "../index.js";

/**
 * Recording sink that also fails on chosen event types (once each, or every
 * time) — used to reproduce "tool succeeded, event/telemetry delivery
 * failed" scenarios deterministically.
 */
function createFailingEventSink(options: {
  failOn: (event: AgentEvent) => boolean;
  /** Default true: only fail the first matching event, then behave normally. */
  once?: boolean;
}): AgentEventSink & { readonly events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  let failed = false;
  const once = options.once ?? true;
  return {
    events,
    async emit(event) {
      if (options.failOn(event) && (!once || !failed)) {
        failed = true;
        throw new Error(`event sink rejected: ${event.type}`);
      }
      events.push(event);
    },
  };
}


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
    "model.turn.metrics",
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

test("LIMITS: repeated same-tool failures force answer-only turn", async () => {
  const sink = createRecordingEventSink();
  let executeCount = 0;
  const tool = createFakeTool({
    name: "document.set_table_cells_text",
    async execute() {
      executeCount += 1;
      throw new AgentCoreError("TOOL_FAILURE", "empty row label", {
        diagnostic: {
          code: "TARGET_NOT_FOUND",
          severity: "error",
          message: "empty row label",
        },
      });
    },
  });
  const model = createScriptedAgentModel([
    toolCallResponse("try1", [
      { id: "c1", name: tool.name, input: {} },
    ]),
    toolCallResponse("try2", [
      { id: "c2", name: tool.name, input: {} },
    ]),
    // Circuit breaker strips tools; this response's toolCalls are ignored.
    toolCallResponse("ignored-tools", [
      { id: "c3", name: tool.name, input: {} },
    ]),
  ]);
  const runner = new AgentRunner({
    model,
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(executeCount, 2);
  assert.equal(
    result.toolOutcomes.filter((o) => o.status === "failed").length,
    2,
  );
  assert.equal(result.summary, "ignored-tools");
});

test("GENERIC SELECTOR: AgentRunner defers entirely to an injected selectTurnTools with no document tool names", async () => {
  // Fake tool surface unrelated to documents — proves AgentRunner has no
  // baked-in knowledge of document/OpenSuite tool names for turn selection.
  const searchTool = createFakeTool({
    name: "widgets.search",
    async execute() {
      return { found: true };
    },
  });
  const buyTool = createFakeTool({
    name: "widgets.buy",
    async execute() {
      return { purchased: true };
    },
  });
  const registry = ToolRegistry.create([searchTool, buyTool]);

  const seenToolChoices: Array<"auto" | "required" | undefined> = [];
  let selectorCalls = 0;
  const selectTurnTools = async (context: {
    toolOutcomes: readonly { toolName: string; status: string }[];
  }) => {
    selectorCalls += 1;
    const bought = context.toolOutcomes.some(
      (o) => o.toolName === "widgets.buy" && o.status === "succeeded",
    );
    const toolChoice = bought ? undefined : ("required" as const);
    seenToolChoices.push(toolChoice);
    return {
      status: "ok" as const,
      registry,
      toolsForModel: registry.definitions(),
      toolChoice,
      capabilities: { ids: new Set<string>() },
    };
  };

  const model = createScriptedAgentModel([
    toolCallResponse("searching", [
      { id: "c1", name: searchTool.name, input: {} },
    ]),
    toolCallResponse("buying", [
      { id: "c2", name: buyTool.name, input: {} },
    ]),
    assistantOnlyResponse("All done shopping."),
  ]);

  const runner = new AgentRunner({
    model,
    tools: ToolRegistry.create([]),
    selectTurnTools,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "All done shopping.");
  assert.equal(selectorCalls, 3);
  assert.deepEqual(seenToolChoices, ["required", "required", undefined]);
  assert.deepEqual(
    result.toolOutcomes.map((o) => o.toolName),
    ["widgets.search", "widgets.buy"],
  );
});

test("GENERIC CONTEXT: createToolContext is resolved once per tool call (no document imports)", async () => {
  // Pure generic AgentRunner: fake tools + selector + context provider.
  // Proves context is not frozen at run start — each sequential tool gets a
  // fresh createToolContext invocation and observes the latest closed-over state.
  const seen: number[] = [];
  let version = 0;
  let contextCalls = 0;
  const write = createFakeTool({
    name: "counter.write",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      seen.push(version);
      version += 1;
      return { wrote: version };
    },
  });
  const registry = ToolRegistry.create([write]);
  const selectTurnTools = async () => ({
    status: "ok" as const,
    registry,
    toolsForModel: registry.definitions(),
    toolChoice: undefined,
    capabilities: { ids: new Set<string>() },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "w1", name: "counter.write", input: {} },
        { id: "w2", name: "counter.write", input: {} },
        { id: "w3", name: "counter.write", input: {} },
      ]),
      assistantOnlyResponse("counted"),
    ]),
    tools: ToolRegistry.create([]),
    selectTurnTools,
    createToolContext: (base) => {
      contextCalls += 1;
      return base;
    },
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(contextCalls, 3);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(result.toolOutcomes.length, 3);
});

test("GENERIC TERMINALIZATION: injected policy can finish after a successful tool batch", async () => {
  const save = createFakeTool({
    name: "notes.save",
    effect: "write",
    async execute() {
      return { saved: true };
    },
  });
  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("Your note is saved.", [
          { id: "save-1", name: save.name, input: {} },
        ]);
      },
    ]),
    tools: ToolRegistry.create([save]),
    shouldTerminalizeToolBatch: ({ toolOutcomes }) =>
      toolOutcomes.every((outcome) => outcome.status === "succeeded"),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Your note is saved.");
  assert.equal(modelCalls, 1);
});

test("GENERIC TERMINALIZATION: false policy continues to the next model turn", async () => {
  const lookup = createFakeTool({
    name: "catalog.lookup",
    async execute() {
      return { found: true };
    },
  });
  let modelCalls = 0;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      () => {
        modelCalls += 1;
        return toolCallResponse("Looking that up now.", [
          { id: "lookup-1", name: lookup.name, input: {} },
        ]);
      },
      () => {
        modelCalls += 1;
        return assistantOnlyResponse("The catalog item is available.");
      },
    ]),
    tools: ToolRegistry.create([lookup]),
    shouldTerminalizeToolBatch: () => false,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "The catalog item is available.");
  assert.equal(modelCalls, 2);
});

test("GENERIC TIMEOUT: injected policy can retry once with a recovery message", async () => {
  let modelCalls = 0;
  let policyCalls = 0;
  const runner = new AgentRunner({
    model: {
      async complete(request: ModelRequest) {
        modelCalls += 1;
        if (modelCalls === 1) {
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
        }
        assert.ok(
          request.messages.some(
            (message) =>
              message.role === "user" && message.content === "Try once more.",
          ),
        );
        return assistantOnlyResponse("Recovered.");
      },
    },
    tools: ToolRegistry.create([]),
    modelTurnTimeoutMs: 20,
    getModelTimeoutRetryMessage: ({ toolOutcomes }) => {
      policyCalls += 1;
      assert.deepEqual(toolOutcomes, []);
      return "Try once more.";
    },
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Recovered.");
  assert.equal(modelCalls, 2);
  assert.equal(policyCalls, 1);
});

// --- AgentCore v2 Step 5A: tool success vs event-sink failure semantics ---

test("STEP5A: successful tool + tool.completed sink rejection does not become a tool failure", async () => {
  let executeCalls = 0;
  const sideEffects: number[] = [];
  const tool = createFakeTool({
    name: "mutate.write",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      executeCalls += 1;
      // The side effect happens and completes before any event is emitted.
      sideEffects.push(executeCalls);
      return { wrote: true };
    },
  });
  const sink = createFailingEventSink({
    failOn: (event) => event.type === "tool.completed",
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "c1", name: "mutate.write", input: {} }]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());

  // Side effect ran exactly once — no duplicate execution/retry.
  assert.equal(executeCalls, 1);
  assert.deepEqual(sideEffects, [1]);

  // The tool outcome carried by the run must stay "succeeded" — event-sink
  // failure must never rewrite it as a tool failure.
  assert.equal(result.toolOutcomes.length, 1);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");

  // No tool.failed event was emitted claiming the execution itself failed.
  assert.ok(!sink.events.some((event) => event.type === "tool.failed"));

  // The model must not be handed a false tool-failure result — the
  // transcript would have been built from the (successful) outcome above,
  // but the run still fails at the infrastructure boundary rather than
  // silently continuing as if nothing happened.
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some((d) => d.code === "EVENT_SINK_FAILURE"),
  );
});

test("STEP5A: successful tool + tool.execution.metrics sink rejection cannot convert success into failure", async () => {
  let executeCalls = 0;
  const tool = createFakeTool({
    name: "mutate.write",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      executeCalls += 1;
      return { wrote: true };
    },
  });
  const sink = createFailingEventSink({
    failOn: (event) => event.type === "tool.execution.metrics",
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "c1", name: "mutate.write", input: {} }]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());

  assert.equal(executeCalls, 1);
  // Telemetry-only failure must not affect the run at all: tool succeeded,
  // run completes normally, no tool.failed, no infrastructure diagnostic.
  assert.equal(result.status, "completed");
  assert.equal(result.toolOutcomes.length, 1);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.ok(!sink.events.some((event) => event.type === "tool.failed"));
  assert.deepEqual(result.diagnostics, []);
});

test("STEP5A: model.turn.metrics sink rejection cannot fail an otherwise-successful model turn", async () => {
  const sink = createFailingEventSink({
    failOn: (event) => event.type === "model.turn.metrics",
    once: false,
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([assistantOnlyResponse("All done.")]),
    tools: ToolRegistry.create([]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "All done.");
  assert.deepEqual(result.diagnostics, []);
});

test("STEP5A: actual tool failure keeps existing tool.failed / failed-outcome semantics", async () => {
  const tool = createFakeTool({
    name: "mutate.write",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      throw new Error("boom: real execution failure");
    },
  });
  const sink = createRecordingEventSink();

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "c1", name: "mutate.write", input: {} }]),
      assistantOnlyResponse("Recovered."),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());

  assert.equal(result.toolOutcomes.length, 1);
  assert.equal(result.toolOutcomes[0]?.status, "failed");
  assert.equal(result.toolOutcomes[0]?.diagnostic?.code, "TOOL_FAILURE");
  assert.ok(sink.events.some((event) => event.type === "tool.failed"));
  assert.equal(result.status, "completed");
});

test("STEP5A: mutation regression — version N+1 persists exactly once despite tool.completed sink failure", async () => {
  // Minimal fake "document store": one successful write advances version by
  // one. The tool applies the side effect first, then the runner's own
  // tool.completed emission (not the tool) fails — reproducing the exact
  // "version persisted, event sink fails" scenario without any DOCX-specific
  // machinery.
  let version = 0;
  const applyCalls: number[] = [];
  const tool = createFakeTool({
    name: "document.mutate",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      version += 1;
      applyCalls.push(version);
      return { versionNumber: version };
    },
  });
  const sink = createFailingEventSink({
    failOn: (event) => event.type === "tool.completed",
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "c1", name: "document.mutate", input: {} }]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());

  // Version N+1 exists exactly once — the mutation was applied exactly once.
  assert.equal(version, 1);
  assert.deepEqual(applyCalls, [1]);

  // The run stopped at the infrastructure boundary instead of continuing
  // (which would otherwise let the model believe the write failed and
  // attempt to retry it, producing version N+2).
  assert.equal(result.status, "failed");
  assert.equal(result.toolOutcomes.length, 1);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.deepEqual(result.toolOutcomes[0]?.output, { versionNumber: 1 });
});

test("STEP5A: successful-path event ordering is unchanged", async () => {
  const sink = createRecordingEventSink();
  const tool = createFakeTool({
    name: "document.mutate",
    effect: "write",
    executionMode: "sequential",
    async execute() {
      return { ok: true };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("Mutating…", [
        { id: "c1", name: "document.mutate", input: {} },
      ]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([tool]),
    events: sink,
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.deepEqual(
    sink.events.map((event) => event.type),
    [
      "agent.started",
      "turn.started",
      "message.started",
      "message.delta",
      "model.turn.metrics",
      "message.completed",
      "tool.started",
      "tool.completed",
      "tool.execution.metrics",
      "turn.completed",
      "turn.started",
      "message.started",
      "message.delta",
      "model.turn.metrics",
      "message.completed",
      "turn.completed",
      "agent.completed",
    ],
  );
});

test("STEP5B: default transformContext is identity (no OpenSuite projection)", async () => {
  const seen: ModelMessage[][] = [];
  const tool = createFakeTool({
    name: "generic.echo",
    async execute() {
      return {
        status: "success",
        richPayload: "CANONICAL_RICH_OUTPUT",
        diagnostics: [],
      };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        { id: "c1", name: "generic.echo", input: { q: "hi" } },
      ]),
      (request: ModelRequest) => {
        seen.push(request.messages.map((m) => structuredClone(m)));
        return assistantOnlyResponse("done");
      },
    ]),
    tools: ToolRegistry.create([tool]),
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(seen.length, 1);

  const toolMsg = seen[0]!.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.equal(toolMsg.toolCallId, "c1");
  assert.deepEqual(toolMsg.output, {
    status: "success",
    richPayload: "CANONICAL_RICH_OUTPUT",
    diagnostics: [],
  });
});

test("STEP5B: injected transformContext shapes model messages; transcript stays canonical", async () => {
  const transformCalls: ModelMessage[][] = [];
  const modelSeen: ModelMessage[][] = [];
  let transformSawCanonical = false;

  const tool = createFakeTool({
    name: "generic.echo",
    async execute() {
      return { status: "success", secret: "KEEP_IN_TRANSCRIPT", diagnostics: [] };
    },
  });

  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("calling", [
        { id: "call-1", name: "generic.echo", input: { n: 1 } },
      ]),
      (request: ModelRequest) => {
        modelSeen.push(request.messages.map((m) => structuredClone(m)));
        return assistantOnlyResponse("ok");
      },
    ]),
    tools: ToolRegistry.create([tool]),
    transformContext(transcript) {
      transformCalls.push(transcript.map((m) => structuredClone(m)));
      const toolMsg = transcript.find((m) => m.role === "tool");
      if (
        toolMsg &&
        toolMsg.role === "tool" &&
        toolMsg.output &&
        typeof toolMsg.output === "object" &&
        "secret" in (toolMsg.output as object)
      ) {
        transformSawCanonical = true;
      }
      return transcript.map((message) => {
        if (message.role !== "tool") return message;
        return {
          ...message,
          output: { projected: true, toolCallId: message.toolCallId },
          summary: "PROJECTED",
        };
      });
    },
  });

  const result = await runner.run(baseRequest());
  assert.equal(result.status, "completed");

  // Transformer ran before the second model.complete (after the tool turn).
  assert.ok(transformCalls.length >= 2);
  assert.equal(modelSeen.length, 1);
  assert.equal(transformSawCanonical, true);

  const modelTool = modelSeen[0]!.find((m) => m.role === "tool");
  assert.ok(modelTool && modelTool.role === "tool");
  assert.equal(modelTool.toolCallId, "call-1");
  assert.equal(modelTool.summary, "PROJECTED");
  assert.deepEqual(modelTool.output, {
    projected: true,
    toolCallId: "call-1",
  });

  // Pairing preserved for the provider.
  const assistantWithCall = modelSeen[0]!.find(
    (m) => m.role === "assistant" && m.toolCalls?.length,
  );
  assert.ok(assistantWithCall && assistantWithCall.role === "assistant");
  assert.equal(assistantWithCall.toolCalls?.[0]?.id, "call-1");

  // Canonical tool outcome (and thus transcript source of truth) unchanged.
  assert.equal(result.toolOutcomes.length, 1);
  assert.deepEqual(result.toolOutcomes[0]?.output, {
    status: "success",
    secret: "KEEP_IN_TRANSCRIPT",
    diagnostics: [],
  });

  // Input to the transformer still had the rich canonical tool result.
  const lastTransformInput = transformCalls[transformCalls.length - 1]!;
  const canonicalTool = lastTransformInput.find((m) => m.role === "tool");
  assert.ok(canonicalTool && canonicalTool.role === "tool");
  assert.deepEqual(canonicalTool.output, {
    status: "success",
    secret: "KEEP_IN_TRANSCRIPT",
    diagnostics: [],
  });
});
