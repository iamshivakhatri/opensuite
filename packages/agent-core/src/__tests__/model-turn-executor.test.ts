import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCapabilities,
  createRecordingEventSink,
  executeModelTurn,
  type AgentEvent,
  type AgentEventSink,
  type ExecuteModelTurnOptions,
  type ModelMessage,
  type ModelRequest,
} from "../index.js";

function options(
  overrides: Partial<ExecuteModelTurnOptions> = {},
): ExecuteModelTurnOptions {
  return {
    model: {
      async complete() {
        return { content: "done", toolCalls: [] };
      },
    },
    transformContext: (transcript) => [...transcript],
    transcript: [{ role: "user", content: "work" }],
    tools: [],
    capabilities: createCapabilities(),
    forceAnswerOnly: false,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    timeoutRetryUsed: false,
    toolOutcomes: [],
    runId: "run-1",
    turnId: "turn-1",
    turnIndex: 0,
    messageId: "message-1",
    events: createRecordingEventSink(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

test("MODEL TURN: normal completion streams, measures, and normalizes response", async () => {
  const events = createRecordingEventSink();
  const result = await executeModelTurn(
    options({
      events,
      model: {
        async complete(request) {
          await request.onTextDelta?.("hel");
          await request.onTextDelta?.("lo");
          return {
            content: "hello",
            toolCalls: [],
            meta: { provider: "fake", modelId: "fake-1", latencyMs: 7 },
          };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.response.content, "hello");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(eventTypes(events.events), [
    "message.started",
    "message.delta",
    "message.delta",
    "model.turn.metrics",
    "message.completed",
  ]);
  assert.deepEqual(
    events.events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.delta),
    ["hel", "lo"],
  );
});

test("MODEL TURN: multiple tool calls survive unchanged", async () => {
  const calls = [
    { id: "call-1", name: "widgets.read", input: { id: 1 } },
    { id: "call-2", name: "widgets.write", input: { id: 2 } },
  ];
  const result = await executeModelTurn(
    options({
      model: {
        async complete() {
          return { content: "working", toolCalls: calls };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.deepEqual(result.toolCalls, calls);
  assert.strictEqual(result.response.toolCalls, calls);
});

test("MODEL TURN: force-answer-only suppresses tools, tool choice, and returned calls", async () => {
  let seenRequest: ModelRequest | undefined;
  const result = await executeModelTurn(
    options({
      forceAnswerOnly: true,
      tools: [
        {
          name: "widgets.read",
          description: "Read a widget",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: "required",
      model: {
        async complete(request) {
          seenRequest = request;
          return {
            content: "answer only",
            toolCalls: [
              { id: "ignored", name: "widgets.read", input: { id: 1 } },
            ],
          };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.deepEqual(seenRequest?.tools, []);
  assert.equal(seenRequest?.toolChoice, undefined);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.toolChoice, undefined);
});

test("MODEL TURN: timeout policy permits exactly one outer-loop retry", async () => {
  let modelCalls = 0;
  let policyCalls = 0;
  const transcript: ModelMessage[] = [{ role: "user", content: "work" }];
  const model = {
    async complete(request: ModelRequest) {
      modelCalls += 1;
      if (modelCalls === 1) {
        await waitForAbort(request.signal);
      }
      assert.ok(
        request.messages.some(
          (message) =>
            message.role === "user" && message.content === "retry once",
        ),
      );
      return { content: "recovered", toolCalls: [] };
    },
  };
  const getTimeoutRetryMessage = () => {
    policyCalls += 1;
    return "retry once";
  };

  const first = await executeModelTurn(
    options({
      model,
      transcript,
      timeoutMs: 10,
      getTimeoutRetryMessage,
    }),
  );
  assert.equal(first.status, "retry");
  if (first.status !== "retry") return;
  transcript.push({ role: "user", content: first.retryMessage });

  const second = await executeModelTurn(
    options({
      model,
      transcript,
      timeoutMs: 10,
      timeoutRetryUsed: true,
      getTimeoutRetryMessage,
      turnId: "turn-2",
      turnIndex: 1,
      messageId: "message-2",
    }),
  );

  assert.equal(second.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(policyCalls, 1);
});

test("MODEL TURN: timeout without retry returns normalized failure", async () => {
  const result = await executeModelTurn(
    options({
      timeoutMs: 10,
      model: {
        async complete(request) {
          await waitForAbort(request.signal);
          return { content: "late", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.code, "MODEL_FAILURE");
  assert.match(result.diagnostic.message, /startup timeout/i);
  assert.equal(result.diagnostic.details?.timeoutSource, "startup");
  assert.equal(result.diagnostic.details?.timeoutMs, 10);
  assert.equal(result.diagnostic.details?.turnIndex, 0);
});

test("MODEL TURN: model errors return normalized failures", async () => {
  const result = await executeModelTurn(
    options({
      model: {
        async complete() {
          throw new Error("provider unavailable");
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.diagnostic, {
    code: "MODEL_FAILURE",
    severity: "error",
    message: "provider unavailable",
  });
});

test("MODEL TURN: parent abort remains cancellation", async () => {
  const controller = new AbortController();
  const resultPromise = executeModelTurn(
    options({
      signal: controller.signal,
      model: {
        async complete(request) {
          await waitForAbort(request.signal);
          return { content: "late", toolCalls: [] };
        },
      },
    }),
  );
  controller.abort();

  assert.deepEqual(await resultPromise, { status: "cancelled" });
});

test("MODEL TURN: telemetry sink failure cannot invalidate success", async () => {
  const events: AgentEvent[] = [];
  const sink: AgentEventSink = {
    emit(event) {
      if (event.type === "model.turn.metrics") {
        throw new Error("metrics unavailable");
      }
      events.push(event);
    },
  };

  const result = await executeModelTurn(options({ events: sink }));
  assert.equal(result.status, "completed");
  assert.deepEqual(eventTypes(events), [
    "message.started",
    "message.completed",
  ]);
});

test("MODEL TURN: required event sink failure remains a model-turn failure", async () => {
  const sink: AgentEventSink = {
    emit(event) {
      if (event.type === "message.completed") {
        throw new Error("required event unavailable");
      }
    },
  };

  const result = await executeModelTurn(options({ events: sink }));
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.code, "MODEL_FAILURE");
  assert.equal(result.diagnostic.message, "required event unavailable");
});

test("MODEL TURN: transformation receives canonical context without mutating it", async () => {
  const transcript: ModelMessage[] = [
    { role: "user", content: "canonical" },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "widgets.read",
      status: "succeeded",
      output: { secret: "canonical-rich-output" },
    },
  ];
  const before = structuredClone(transcript);
  let transformCalls = 0;
  let modelMessages: readonly ModelMessage[] = [];

  const result = await executeModelTurn(
    options({
      transcript,
      transformContext(messages) {
        transformCalls += 1;
        assert.strictEqual(messages, transcript);
        return messages.map((message) =>
          message.role === "tool"
            ? { ...message, output: { projected: true } }
            : message,
        );
      },
      model: {
        async complete(request) {
          modelMessages = request.messages;
          return { content: "done", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  assert.equal(transformCalls, 1);
  assert.deepEqual(transcript, before);
  const projected = modelMessages.find((message) => message.role === "tool");
  assert.ok(projected && projected.role === "tool");
  assert.deepEqual(projected.output, { projected: true });
});

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), {
      once: true,
    });
  });
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("MODEL TURN A: continuous tool-call activity survives past idle budget", async () => {
  let toolCallsSeen = 0;
  const result = await executeModelTurn(
    options({
      timeoutMs: 80,
      hardTimeoutMs: 2_000,
      model: {
        async complete(request) {
          // Wall clock > idle budget, but fragments keep arriving.
          for (let i = 0; i < 8; i += 1) {
            request.onModelActivity?.("tool_call_arguments_delta");
            await sleep(25);
          }
          toolCallsSeen += 1;
          return {
            content: "",
            toolCalls: [
              { id: "c1", name: "widgets.write", input: { ok: true } },
            ],
          };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(toolCallsSeen, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "widgets.write");
});

test("MODEL TURN B: stream idle timeout aborts and may retry before visible text", async () => {
  let modelCalls = 0;
  const model = {
    async complete(request: ModelRequest) {
      modelCalls += 1;
      if (modelCalls === 1) {
        request.onModelActivity?.("tool_call_start");
        await waitForAbort(request.signal);
      }
      return { content: "recovered", toolCalls: [] };
    },
  };

  const first = await executeModelTurn(
    options({
      model,
      timeoutMs: 30,
      hardTimeoutMs: 2_000,
      getTimeoutRetryMessage: () => "retry after idle",
    }),
  );
  assert.equal(first.status, "retry");
  if (first.status !== "retry") return;
  assert.equal(first.retryMessage, "retry after idle");

  const second = await executeModelTurn(
    options({
      model,
      timeoutMs: 30,
      hardTimeoutMs: 2_000,
      timeoutRetryUsed: true,
      getTimeoutRetryMessage: () => "retry after idle",
      turnId: "turn-2",
      turnIndex: 1,
      messageId: "message-2",
    }),
  );
  assert.equal(second.status, "completed");
  assert.equal(modelCalls, 2);
});

test("MODEL TURN C: no first activity hits startup timeout", async () => {
  const result = await executeModelTurn(
    options({
      timeoutMs: 25,
      hardTimeoutMs: 2_000,
      model: {
        async complete(request) {
          await waitForAbort(request.signal);
          return { content: "late", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.details?.timeoutSource, "startup");
  assert.match(result.diagnostic.message, /startup timeout/i);
});

test("MODEL TURN D: transport-only noise does not reset idle timer", async () => {
  const result = await executeModelTurn(
    options({
      timeoutMs: 40,
      hardTimeoutMs: 2_000,
      model: {
        async complete(request) {
          request.onModelActivity?.("tool_call_start");
          // Simulate heartbeats / empty SSE — no onModelActivity.
          for (let i = 0; i < 8; i += 1) {
            await sleep(15);
          }
          await waitForAbort(request.signal);
          return { content: "late", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.details?.timeoutSource, "idle");
  assert.match(result.diagnostic.message, /idle timeout/i);
});

test("MODEL TURN E: visible text blocks unsafe timeout retry", async () => {
  const events = createRecordingEventSink();
  let modelCalls = 0;
  const result = await executeModelTurn(
    options({
      events,
      timeoutMs: 30,
      hardTimeoutMs: 2_000,
      getTimeoutRetryMessage: () => "should not retry",
      model: {
        async complete(request) {
          modelCalls += 1;
          await request.onTextDelta?.("Hello visible");
          await waitForAbort(request.signal);
          return { content: "Hello visible", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(modelCalls, 1);
  assert.equal(result.diagnostic.details?.timeoutSource, "idle");
  assert.equal(result.diagnostic.details?.visibleTextEmitted, true);
  assert.equal(
    events.events.filter((event) => event.type === "message.delta").length,
    1,
  );
});

test("MODEL TURN F: tool-call fragments alone keep liveness without visible text", async () => {
  const events = createRecordingEventSink();
  const result = await executeModelTurn(
    options({
      events,
      timeoutMs: 80,
      hardTimeoutMs: 2_000,
      model: {
        async complete(request) {
          for (let i = 0; i < 6; i += 1) {
            request.onModelActivity?.(
              i === 0 ? "tool_call_start" : "tool_call_arguments_delta",
            );
            await sleep(25);
          }
          return {
            content: "",
            toolCalls: [
              { id: "c1", name: "widgets.read", input: { id: 1 } },
            ],
          };
        },
      },
    }),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.response.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(
    events.events.filter((event) => event.type === "message.delta").length,
    0,
  );
});

test("MODEL TURN G: external cancellation is not labeled as timeout", async () => {
  const controller = new AbortController();
  const resultPromise = executeModelTurn(
    options({
      signal: controller.signal,
      timeoutMs: 5_000,
      hardTimeoutMs: 10_000,
      getTimeoutRetryMessage: () => "should not apply",
      model: {
        async complete(request) {
          request.onModelActivity?.("text_delta");
          await waitForAbort(request.signal);
          return { content: "late", toolCalls: [] };
        },
      },
    }),
  );
  await sleep(5);
  controller.abort();

  assert.deepEqual(await resultPromise, { status: "cancelled" });
});

test("MODEL TURN H: absolute hard ceiling terminates endless trickle", async () => {
  const result = await executeModelTurn(
    options({
      timeoutMs: 200,
      hardTimeoutMs: 80,
      model: {
        async complete(request) {
          // Continuous meaningful activity — idle never fires; hard must.
          while (!request.signal?.aborted) {
            request.onModelActivity?.("tool_call_arguments_delta");
            await sleep(10);
          }
          await waitForAbort(request.signal);
          return { content: "", toolCalls: [] };
        },
      },
    }),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.details?.timeoutSource, "hard");
  assert.match(result.diagnostic.message, /hard ceiling/i);
});
