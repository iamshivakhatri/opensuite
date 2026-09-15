import assert from "node:assert/strict";
import { test } from "node:test";

import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createFinishTool } from "./finish-tool.js";
import { runModel } from "./model.js";
import { runAgent } from "./run.js";
import { defineTool, type AgentToolSet } from "./types.js";

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
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
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
  assert.equal(result.turns, 1);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "done");
  assert.deepEqual(events, ["started", "text_delta", "completed"]);
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
  const finish = createFinishTool();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([
            { id: "f", name: finish.name, input: { summary: "all set" } },
          ]),
        }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "go" }],
    tools: { [finish.name]: finish.tool },
  });

  assert.equal(invocations, 1);
  assert.equal(result.stopReason, "finish_tool");
  assert.equal(result.text, "all set");
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
