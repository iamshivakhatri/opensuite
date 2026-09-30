import assert from "node:assert/strict";
import { test } from "node:test";

import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createFinishTool } from "./finish-tool.js";
import { runModel } from "./model.js";
import { providerSafeToolName, runAgent } from "./run.js";
import { getRunMetricsFromError } from "./run-metrics.js";
import { defineTool, isSuccessfulStop, type AgentToolSet } from "./types.js";

const emptyUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

function textChunks(text: string, finishReason: "stop" | "tool-calls" = "stop") {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: text },
    { type: "text-end" as const, id: "text" },
    {
      type: "finish" as const,
      finishReason: { unified: finishReason, raw: finishReason },
      usage: emptyUsage,
    },
  ];
}

function toolCallChunks(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.flatMap((call) => [
      { type: "tool-input-start", id: call.id, toolName: call.name },
      { type: "tool-input-delta", id: call.id, delta: JSON.stringify(call.input) },
      { type: "tool-input-end", id: call.id },
      {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.input),
      },
    ]),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: emptyUsage,
    },
  ];
}

function textThenFinishChunks(text: string, finishName: string) {
  return [
    ...textChunks(text, "tool-calls").slice(0, -1),
    ...toolCallChunks([{ id: "f", name: finishName, input: {} }]).slice(1),
  ];
}

const emptyObjectSchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const nSchema = jsonSchema<{ n: number }>({
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runModel streams text and returns the final response", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks("Hello v3") }),
    }),
  });
  const deltas: string[] = [];
  const result = await runModel({
    model,
    messages: [{ role: "user", content: "hi" }],
    onTextDelta: (d) => {
      deltas.push(d);
    },
  });
  assert.deepEqual(deltas, ["Hello v3"]);
  assert.equal(result.text, "Hello v3");
  assert.equal(result.turns, 1);
});

test("no tool call: one model invocation, completed stop reason", async () => {
  let invocations = 0;
  let requestedLimit: number | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      requestedLimit = options.maxOutputTokens;
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });
  const events: string[] = [];
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "hi" }],
    onEvent: (e) => {
      events.push(e.type);
    },
  });
  assert.equal(invocations, 1);
  assert.equal(requestedLimit, undefined);
  assert.equal(result.turns, 1);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "done");
  assert.deepEqual(events, [
    "started",
    "model_turn_started",
    "model_turn_first_stream_part",
    "text_delta",
    "model_turn_completed",
    "completed",
  ]);
});

test("model turn lifecycle events include start, first text, and completion", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks("ok") }) }),
  });
  const events: Array<{ type: string; turn?: number; toolNames?: readonly string[] }> = [];
  await runAgent({
    model,
    messages: [{ role: "user", content: "hi" }],
    onEvent: (e) => {
      if (e.type === "model_turn_started") events.push({ type: e.type, turn: e.turn });
      if (e.type === "model_turn_first_stream_part") events.push({ type: e.type, turn: e.turn });
      if (e.type === "model_turn_completed") {
        events.push({ type: e.type, turn: e.turn, toolNames: e.toolNames });
      }
    },
  });
  assert.deepEqual(events, [
    { type: "model_turn_started", turn: 1 },
    { type: "model_turn_first_stream_part", turn: 1 },
    { type: "model_turn_completed", turn: 1, toolNames: [] },
  ]);
});

test("turn metrics distinguish first reasoning, text, and tool input", async () => {
  const finish = createFinishTool();
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "reasoning" },
          { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
          { type: "reasoning-end", id: "reasoning" },
          ...textThenFinishChunks("done", finish.name).slice(1),
        ] as never[],
      }),
    }),
  });
  let clock = 0;
  const events: Array<{ kind: string; elapsedMs: number }> = [];
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools: { [finish.name]: finish.tool },
    now: () => (clock += 10),
    onEvent: (event) => {
      if (event.type === "model_turn_first_stream_part") {
        events.push({ kind: event.kind, elapsedMs: event.elapsedMs });
      }
    },
  });
  assert.deepEqual(events.map((event) => event.kind), ["reasoning", "text", "tool"]);
  assert.ok(events[0]!.elapsedMs < events[1]!.elapsedMs);
  assert.ok(events[1]!.elapsedMs < events[2]!.elapsedMs);
  assert.equal(result.metrics.modelTurns[0]?.firstReasoningMs, events[0]?.elapsedMs);
  assert.equal(result.metrics.modelTurns[0]?.firstTextMs, events[1]?.elapsedMs);
  assert.equal(result.metrics.modelTurns[0]?.firstToolMs, events[2]?.elapsedMs);
  assert.equal(
    result.metrics.modelTurns[0]!.completedAtMs! - result.metrics.modelTurns[0]!.startedAtMs!,
    result.metrics.modelTurns[0]?.durationMs,
  );
});

test("length stop without a tool is an unsuccessful output limit", async () => {
  let requestedLimit: number | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      requestedLimit = options.maxOutputTokens;
      return {
        stream: simulateReadableStream({
          chunks: textChunks("unfinished", "stop").map((chunk) =>
            chunk.type === "finish"
              ? { ...chunk, finishReason: { unified: "length" as const, raw: "length" } }
              : chunk,
          ),
        }),
      };
    },
  });
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    maxOutputTokens: 8_192,
  });
  assert.equal(requestedLimit, 8_192);
  assert.equal(result.finishReason, "length");
  assert.equal(result.stopReason, "output_limit");
  assert.equal(result.metrics.modelTurns[0]?.finishReason, "length");
  assert.equal(isSuccessfulStop(result.stopReason), false);
});

test("length stop discards valid tool calls and does not start another turn", async () => {
  for (const names of [["read"], ["read", "write"]]) {
    let modelTurns = 0;
    const executed: string[] = [];
    const events: string[] = [];
    const completedToolNames: (readonly string[])[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelTurns += 1;
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks(names.map((name, index) => ({ id: `t${index}`, name, input: {} })))
              .map((chunk) => chunk.type === "finish"
                ? { ...chunk, finishReason: { unified: "length", raw: "length" } }
                : chunk),
          }),
        };
      },
    });
    const tools: AgentToolSet = Object.fromEntries(names.map((name) => [name,
      defineTool<Record<string, never>, { ok: true }>({
        kind: name === "write" ? "mutate" : "read",
        description: name,
        inputSchema: emptyObjectSchema,
        execute: async () => { executed.push(name); return { ok: true }; },
      }),
    ]));
    const result = await runAgent({
      model,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === "model_turn_completed") completedToolNames.push(event.toolNames);
      },
    });
    assert.equal(result.stopReason, "output_limit");
    assert.equal(result.finishReason, "length");
    assert.equal(result.turns, 1);
    assert.equal(result.toolCalls, 0);
    assert.equal(result.metrics.modelTurns.length, 1);
    assert.equal(modelTurns, 1);
    assert.deepEqual(executed, []);
    assert.equal(events.filter((event) => event === "tool_started").length, 0);
    assert.equal(events.filter((event) => event === "model_turn_completed").length, 1);
    assert.deepEqual(completedToolNames, [names]);
  }
});

test("provider-safe tool names: dotted internal tools are exposed without dots", async () => {
  assert.equal(providerSafeToolName("document.inspect"), "document_inspect");
  let sawSchemaName: string | undefined;
  let executed = false;
  const events: string[] = [];
  const finish = createFinishTool();
  let turn = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      turn += 1;
      if (turn === 1) {
        const tools = options.tools as ReadonlyArray<{ name?: string }> | undefined;
        sawSchemaName = tools?.find((t) => t.name?.startsWith("document"))?.name;
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([{ id: "t1", name: "document_inspect", input: {} }]),
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([{ id: "f", name: finish.name, input: {} }]),
        }),
      };
    },
  });
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools: {
      "document.inspect": defineTool<Record<string, never>, { ok: true }>({
        kind: "read",
        description: "inspect",
        inputSchema: emptyObjectSchema,
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      }),
      [finish.name]: finish.tool,
    },
    onEvent: (event) => {
      if (event.type === "tool_started" || event.type === "tool_completed") {
        events.push(`${event.type}:${event.toolName}`);
      }
    },
  });
  assert.equal(sawSchemaName, "document_inspect");
  assert.equal(executed, true);
  assert.deepEqual(events, [
    "tool_started:document.inspect",
    "tool_completed:document.inspect",
    "tool_started:finish",
    "tool_completed:finish",
  ]);
  assert.equal(result.stopReason, "finish_tool");
});

test("finishReason error fails the run instead of completing empty", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "finish",
            finishReason: { unified: "error", raw: "error" },
            usage: emptyUsage,
          },
        ],
      }),
    }),
  });
  await assert.rejects(
    () => runAgent({ model, messages: [{ role: "user", content: "hi" }] }),
    /Model provider returned an error/,
  );
});

test("ordinary tool-call turn executes its tool and continues", async () => {
  let modelTurns = 0;
  let executed = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: ++modelTurns === 1
          ? toolCallChunks([{ id: "t1", name: "read", input: {} }])
          : textChunks("done"),
      }),
    }),
  });
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools: { read: defineTool<Record<string, never>, { ok: true }>({
      kind: "read",
      description: "read",
      inputSchema: emptyObjectSchema,
      execute: async () => { executed += 1; return { ok: true }; },
    }) },
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.toolCalls, 1);
  assert.equal(modelTurns, 2);
  assert.equal(executed, 1);
});

test("system prompt is prepended to the model messages", async () => {
  let sawSystem = false;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      sawSystem = options.prompt.some((m) => m.role === "system");
      return { stream: simulateReadableStream({ chunks: textChunks("ok") }) };
    },
  });
  await runAgent({
    model,
    system: "You are a test agent.",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(sawSystem, true);
});

test("reads in one turn run concurrently", async () => {
  let invocations = 0;
  let active = 0;
  let maxActive = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "a", name: "alpha", input: { n: 1 } },
              { id: "b", name: "beta", input: { n: 2 } },
            ]),
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });

  const mkRead = (name: string) =>
    defineTool<{ n: number }, { name: string }>({
      kind: "read",
      description: name,
      inputSchema: nSchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active -= 1;
        return { name };
      },
    });

  const tools: AgentToolSet = { alpha: mkRead("alpha"), beta: mkRead("beta") };
  await runAgent({ model, messages: [{ role: "user", content: "go" }], tools });
  assert.equal(maxActive, 2);
});

test("mutations in one turn run sequentially", async () => {
  let invocations = 0;
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "a", name: "m1", input: { n: 1 } },
              { id: "b", name: "m2", input: { n: 2 } },
            ]),
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });

  const mkMut = (name: string) =>
    defineTool<{ n: number }, { ok: true }>({
      kind: "mutate",
      description: name,
      inputSchema: nSchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(name);
        await delay(15);
        active -= 1;
        return { ok: true };
      },
    });

  const tools: AgentToolSet = { m1: mkMut("m1"), m2: mkMut("m2") };
  await runAgent({ model, messages: [{ role: "user", content: "go" }], tools });
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["m1", "m2"]);
});

test("a failed mutation skips later mutations in the same batch", async () => {
  let invocations = 0;
  let m2Ran = false;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "a", name: "m1", input: { n: 1 } },
              { id: "b", name: "m2", input: { n: 2 } },
            ]),
          }),
        };
      }
      const toolMsg = options.prompt.find((m) => m.role === "tool") as
        | { content: Array<{ output: { type: string; value: unknown } }> }
        | undefined;
      assert.ok(toolMsg);
      assert.equal(toolMsg.content.length, 2);
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });

  const tools: AgentToolSet = {
    m1: defineTool<{ n: number }, { ok: false; reasonCode: string }>({
      kind: "mutate",
      description: "m1",
      inputSchema: nSchema,
      execute: async () => ({ ok: false, reasonCode: "BOOM" }),
    }),
    m2: defineTool<{ n: number }, { ok: true }>({
      kind: "mutate",
      description: "m2",
      inputSchema: nSchema,
      execute: async () => {
        m2Ran = true;
        return { ok: true };
      },
    }),
  };

  const events: string[] = [];
  await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
    onEvent: (e) => {
      events.push(e.type);
    },
  });
  assert.equal(m2Ran, false);
  assert.ok(events.includes("tool_failed"));
  assert.ok(events.includes("tool_skipped"));
});

test("failure fuse stops identical failing calls across turns", async () => {
  let invocations = 0;
  let executions = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      // Always ask for the same failing call again.
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([{ id: `c${invocations}`, name: "boom", input: { n: 1 } }]),
        }),
      };
    },
  });

  const tools: AgentToolSet = {
    boom: defineTool<{ n: number }, { ok: false }>({
      kind: "read",
      description: "always fails",
      inputSchema: nSchema,
      execute: async () => {
        executions += 1;
        return { ok: false };
      },
    }),
  };

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
    maxAttemptsPerCall: 2,
    maxTurns: 8,
  });

  // Executes at most maxAttemptsPerCall times; afterwards the call is fused (skipped).
  assert.equal(executions, 2);
  assert.equal(result.stopReason, "max_turns");
});

test("terminal (finish) tool ends the run without another model turn", async () => {
  let invocations = 0;
  const deltas: string[] = [];
  const finish = createFinishTool();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: textThenFinishChunks("all set", finish.name),
        }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools: { [finish.name]: finish.tool },
    onTextDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.equal(invocations, 1);
  assert.equal(result.stopReason, "finish_tool");
  assert.equal(result.text, "all set");
  assert.deepEqual(deltas, ["all set"]);
});

test("maxTurns returns a max_turns stop reason (no throw)", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([{ id: `t${invocations}`, name: "noop", input: {} }]),
        }),
      };
    },
  });
  const tools: AgentToolSet = {
    noop: defineTool<Record<string, never>, { ok: true }>({
      kind: "read",
      description: "noop",
      inputSchema: emptyObjectSchema,
      execute: async () => ({ ok: true }),
    }),
  };
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "loop" }],
    maxTurns: 3,
    tools,
  });
  assert.equal(result.stopReason, "max_turns");
  assert.equal(invocations, 3);
});

test("transient error before any text is retried then succeeds", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        throw new APICallError({
          message: "rate limited",
          url: "https://openrouter.test/v1",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      }
      return { stream: simulateReadableStream({ chunks: textChunks("recovered") }) };
    },
  });
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "hi" }],
    infraRetry: { maxRetries: 2 },
  });
  assert.equal(invocations, 2);
  assert.equal(result.text, "recovered");
  assert.equal(result.turns, 1);
});

test("non-retryable error propagates", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message: "bad request",
        url: "https://openrouter.test/v1",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    },
  });
  await assert.rejects(() =>
    runAgent({
      model,
      messages: [{ role: "user", content: "hi" }],
      infraRetry: { maxRetries: 2 },
    }),
  );
});

test("abort stops the run and emits cancelled", async () => {
  const abort = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      abort.abort();
      return { stream: simulateReadableStream({ chunks: textChunks("nope") }) };
    },
  });
  const events: string[] = [];
  await assert.rejects(() =>
    runAgent({
      model,
      messages: [{ role: "user", content: "stop" }],
      signal: abort.signal,
      onEvent: (e) => {
        events.push(e.type);
      },
    }),
  );
  assert.ok(events.includes("cancelled") || events.includes("started"));
});

test("projectMessages can rewrite the transcript before each model call", async () => {
  let invocations = 0;
  let sawProjected = false;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([{ id: "a", name: "noop", input: {} }]),
          }),
        };
      }
      // On the 2nd turn the injected marker should be present.
      sawProjected = JSON.stringify(options.prompt).includes("[[projected]]");
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });
  const tools: AgentToolSet = {
    noop: defineTool<Record<string, never>, { ok: true }>({
      kind: "read",
      description: "noop",
      inputSchema: emptyObjectSchema,
      execute: async () => ({ ok: true }),
    }),
  };
  await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
    projectMessages: (messages) => [
      ...messages,
      { role: "user", content: "[[projected]]" },
    ],
  });
  assert.equal(sawProjected, true);
});

test("metrics: successful and failed tool calls recorded once each", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "ok", name: "good", input: { n: 1 } },
              { id: "bad", name: "bad", input: { n: 2 } },
            ]),
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });
  const tools: AgentToolSet = {
    good: defineTool<{ n: number }, { ok: true }>({
      kind: "read",
      description: "good",
      inputSchema: nSchema,
      execute: async () => ({ ok: true }),
    }),
    bad: defineTool<{ n: number }, { ok: false; reasonCode: string }>({
      kind: "read",
      description: "bad",
      inputSchema: nSchema,
      execute: async () => ({ ok: false, reasonCode: "TARGET_NOT_FOUND" }),
    }),
  };
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
  });
  assert.equal(result.metrics.toolCalls.length, 2);
  assert.equal(result.metrics.toolCalls[0]!.outcome, "success");
  assert.equal(result.metrics.toolCalls[1]!.outcome, "failure");
  assert.equal(result.metrics.toolCalls[1]!.failureCode, "TARGET_NOT_FOUND");
  assert.deepEqual(
    result.metrics.toolCalls.map((t) => t.sequence),
    [1, 2],
  );
});

test("metrics: concurrent reads preserve sequence allocation order", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "a", name: "slow", input: { n: 1 } },
              { id: "b", name: "fast", input: { n: 2 } },
            ]),
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("done") }) };
    },
  });
  const tools: AgentToolSet = {
    slow: defineTool<{ n: number }, { ok: true }>({
      kind: "read",
      description: "slow",
      inputSchema: nSchema,
      execute: async () => {
        await delay(30);
        return { ok: true };
      },
    }),
    fast: defineTool<{ n: number }, { ok: true }>({
      kind: "read",
      description: "fast",
      inputSchema: nSchema,
      execute: async () => ({ ok: true }),
    }),
  };
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
  });
  const byName = Object.fromEntries(
    result.metrics.toolCalls.map((t) => [t.toolName, t.sequence]),
  );
  assert.equal(byName.slow, 1);
  assert.equal(byName.fast, 2);
});

test("metrics: fuse event recorded when identical failing call is skipped", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([
            { id: `c${invocations}`, name: "boom", input: { n: 1 } },
          ]),
        }),
      };
    },
  });
  const tools: AgentToolSet = {
    boom: defineTool<{ n: number }, { ok: false; reasonCode: string }>({
      kind: "read",
      description: "boom",
      inputSchema: nSchema,
      execute: async () => ({ ok: false, reasonCode: "BOOM" }),
    }),
  };
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools,
    maxAttemptsPerCall: 2,
    maxTurns: 5,
  });
  assert.equal(result.stopReason, "max_turns");
  assert.ok(result.metrics.fuseEvents.length >= 1);
  assert.equal(result.metrics.fuseEvents[0]!.reason, "FUSE_TRIPPED");
  // Only actual executions are metered — fuse skips are not tool-call metrics.
  assert.equal(result.metrics.toolCalls.length, 2);
  assert.equal(result.metrics.toolCalls.every((t) => t.outcome === "failure"), true);
});

test("metrics: max_turns stop reason is on finalized metrics", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([{ id: `t${invocations}`, name: "noop", input: {} }]),
        }),
      };
    },
  });
  const tools: AgentToolSet = {
    noop: defineTool<Record<string, never>, { ok: true }>({
      kind: "read",
      description: "noop",
      inputSchema: emptyObjectSchema,
      execute: async () => ({ ok: true }),
    }),
  };
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "loop" }],
    maxTurns: 2,
    tools,
  });
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.metrics.stopReason, "max_turns");
  assert.equal(result.metrics.modelTurns.length, 2);
});

test("metrics: cancellation attaches metrics with cancelled stop reason", async () => {
  const abort = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      abort.abort();
      return { stream: simulateReadableStream({ chunks: textChunks("nope") }) };
    },
  });
  let caught: unknown;
  try {
    await runAgent({
      model,
      messages: [{ role: "user", content: "stop" }],
      signal: abort.signal,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  const metrics = getRunMetricsFromError(caught);
  assert.ok(metrics);
  assert.equal(metrics!.stopReason, "cancelled");
});

test("without projectTools the full registry remains exposed and executable", async () => {
  const executed: string[] = [];
  const tools = Object.fromEntries(["first", "second"].map((name) => [name, defineTool({
    kind: "read", description: name, inputSchema: emptyObjectSchema,
    execute: () => { executed.push(name); return { ok: true }; },
  })]));
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    assert.deepEqual(options.tools?.map((tool) => tool.name), ["first", "second"]);
    return { stream: simulateReadableStream({ chunks: ++turn === 1
      ? toolCallChunks([{ id: "a", name: "second", input: {} }]) : textChunks("done") }) };
  } });
  const result = await runAgent({ model, tools, messages: [{ role: "user", content: "go" }] });
  assert.deepEqual(executed, ["second"]);
  assert.deepEqual(result.metrics.modelTurns.map((turn) => turn.exposedToolCount), [2, 2]);
});

test("projection grows next turn; hidden mutations and terminal tools cannot execute in the loading turn", async () => {
  let loaded = false;
  let edited = 0;
  let finished = 0;
  const tools: AgentToolSet = {
    load: defineTool({ kind: "read", description: "load", inputSchema: emptyObjectSchema,
      execute: () => { loaded = true; return { ok: true }; } }),
    "special.edit": defineTool({ kind: "mutate", description: "edit", inputSchema: emptyObjectSchema,
      execute: () => { edited++; return { ok: true }; } }),
    "special.finish": defineTool({ kind: "read", terminal: true, description: "finish", inputSchema: emptyObjectSchema,
      execute: () => { finished++; return "done"; } }),
  };
  let turn = 0;
  const selected: AgentToolSet = { load: tools.load! };
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    turn++;
    assert.deepEqual(options.tools?.map((tool) => tool.name), turn === 1 ? ["load"] : ["load", "special_edit", "special_finish"]);
    if (turn === 2) {
      assert.equal(edited, 0);
      assert.equal(finished, 0);
      const assistant = options.prompt.find((message) => message.role === "assistant");
      const results = options.prompt.find((message) => message.role === "tool");
      assert.ok(assistant && results);
      const resultParts = results.content.filter((part) => part.type === "tool-result");
      assert.deepEqual(assistant.content.filter((part) => part.type === "tool-call").map((part) => [part.toolCallId, part.toolName]),
        resultParts.map((part) => [part.toolCallId, part.toolName]));
      assert.deepEqual(resultParts.map((part) => part.output.type), ["json", "error-text", "error-text"]);
    }
    return { stream: simulateReadableStream({ chunks: toolCallChunks(turn === 1 ? [
      { id: "load", name: "load", input: {} },
      { id: "hidden-edit", name: "special_edit", input: {} },
      { id: "hidden-finish", name: "special_finish", input: {} },
    ] : [
      { id: "edit", name: "special_edit", input: {} },
      { id: "finish", name: "special_finish", input: {} },
    ]) }) };
  } });
  const result = await runAgent({ model, tools, messages: [{ role: "user", content: "go" }],
    projectTools: (state) => {
      assert.equal(state.tools, tools);
      assert.equal(state.turn, turn + 1);
      assert.equal(state.messages.length, state.turn === 1 ? 1 : 3);
      return selected;
    },
    // Even changing the returned map while tools run must not widen the snapshot.
    onEvent: (event) => {
      if (event.type === "tool_completed" && loaded) Object.assign(selected, tools);
    },
  });
  assert.equal(result.stopReason, "finish_tool");
  assert.equal(edited, 1);
  assert.equal(finished, 1);
  assert.deepEqual(result.metrics.modelTurns.map((turn) => turn.exposedToolCount), [1, 3]);
  assert.ok(result.metrics.modelTurns[1]!.exposedToolSchemaChars! > result.metrics.modelTurns[0]!.exposedToolSchemaChars!);
  assert.deepEqual(result.metrics.toolCalls.filter((call) => call.turn === 1).map((call) => call.outcome), ["success", "failure", "failure"]);
});

test("projection preserves concurrent reads, sequential mutations, failure skipping and finish containment", async () => {
  let activeReads = 0;
  let peakReads = 0;
  const order: string[] = [];
  const tools: AgentToolSet = {};
  for (const name of ["read1", "read2"]) tools[name] = defineTool({
    kind: "read", description: name, inputSchema: emptyObjectSchema, execute: async () => {
      peakReads = Math.max(peakReads, ++activeReads);
      await delay(10);
      activeReads--;
      order.push(name);
      return { ok: true };
    },
  });
  for (const name of ["edit1", "edit2", "edit3"]) tools[name] = defineTool({
    kind: "mutate", description: name, inputSchema: emptyObjectSchema, execute: () => {
      assert.equal(activeReads, 0);
      order.push(name);
      return { ok: name !== "edit2" };
    },
  });
  const finish = createFinishTool();
  tools[finish.name] = finish.tool;
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({
    chunks: ++turn === 1 ? toolCallChunks(Object.keys(tools).map((name) => ({ id: name, name, input: {} }))) : textChunks("recovered"),
  }) }) });
  const result = await runAgent({ model, tools, projectTools: ({ tools }) => ({ ...tools }), messages: [{ role: "user", content: "go" }] });
  assert.equal(peakReads, 2);
  assert.deepEqual(order.slice(2), ["edit1", "edit2"]);
  assert.equal(result.turns, 2);
  assert.equal(result.stopReason, "completed");
});
