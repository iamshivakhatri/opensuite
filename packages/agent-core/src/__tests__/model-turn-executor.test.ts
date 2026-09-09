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
  assert.match(result.diagnostic.message, /exceeded 10ms/);
  assert.deepEqual(result.diagnostic.details, {
    timeoutMs: 10,
    turnIndex: 0,
  });
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
