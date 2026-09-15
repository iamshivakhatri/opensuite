import assert from "node:assert/strict";
import { test } from "node:test";

import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { MaxTurnsExceededError, runAgent, runModel } from "./model.js";

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
      {
        type: "tool-input-delta",
        id: call.id,
        delta: JSON.stringify(call.input),
      },
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

const emptyObjectSchema = jsonSchema<{ _?: never }>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

test("runModel streams text and returns the final response", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: textChunks("Hello OpenSuite"),
      }),
    }),
  });
  const deltas: string[] = [];

  const result = await runModel({
    model,
    messages: [{ role: "user", content: "Say hello" }],
    onTextDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, ["Hello OpenSuite"]);
  assert.equal(result.text, "Hello OpenSuite");
  assert.equal(result.inputTokens, 1);
  assert.equal(result.outputTokens, 1);
  assert.equal(result.turns, 1);
});

test("TEST A — no tool call: exactly one model invocation", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({ chunks: textChunks("done") }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(invocations, 1);
  assert.equal(result.turns, 1);
  assert.equal(result.text, "done");
});

test("TEST B — one tool then final text", async () => {
  let invocations = 0;
  const executed: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "c1", name: "echo", input: { value: "ping" } },
            ]),
          }),
        };
      }
      const toolMsg = options.prompt.find((m) => m.role === "tool");
      executed.push(toolMsg);
      return {
        stream: simulateReadableStream({ chunks: textChunks("got ping") }),
      };
    },
  });

  let echoCalls = 0;
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "echo" }],
    tools: {
      echo: tool({
        description: "echo",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        }),
        execute: async ({ value }) => {
          echoCalls += 1;
          return { echoed: value };
        },
      }),
    },
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(echoCalls, 1);
  assert.equal(result.text, "got ping");
  const toolMsg = executed[0] as { role: string; content: unknown[] };
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.content.length, 1);
});

test("TEST C — many sibling tools in one turn before next model call", async () => {
  let invocations = 0;
  let modelTurn2SawResults = false;
  const order: string[] = [];

  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "a", name: "alpha", input: { n: 1 } },
              { id: "b", name: "beta", input: { n: 2 } },
              { id: "c", name: "gamma", input: { n: 3 } },
            ]),
          }),
        };
      }

      // Invocation #2 must not start until A,B,C produced results.
      assert.deepEqual(order, ["alpha", "beta", "gamma"]);
      const toolMsg = options.prompt.find((m) => m.role === "tool") as
        | { content: Array<{ toolCallId: string; toolName: string }> }
        | undefined;
      assert.ok(toolMsg);
      assert.equal(toolMsg.content.length, 3);
      assert.deepEqual(
        toolMsg.content.map((part) => part.toolName),
        ["alpha", "beta", "gamma"],
      );
      modelTurn2SawResults = true;

      return {
        stream: simulateReadableStream({ chunks: textChunks("all three") }),
      };
    },
  });

  const mk = (name: string) =>
    tool({
      description: name,
      inputSchema: jsonSchema<{ n: number }>({
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
        additionalProperties: false,
      }),
      execute: async ({ n }) => {
        order.push(name);
        return { name, n };
      },
    });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "run three" }],
    tools: {
      alpha: mk("alpha"),
      beta: mk("beta"),
      gamma: mk("gamma"),
    },
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(order.length, 3);
  assert.equal(modelTurn2SawResults, true);
  assert.equal(result.text, "all three");
});

test("TEST D — tool failure reaches next model turn (no recovery loop)", async () => {
  let invocations = 0;
  let sawFailure = false;

  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              { id: "f1", name: "boom", input: {} },
            ]),
          }),
        };
      }
      const toolMsg = options.prompt.find((m) => m.role === "tool") as
        | {
            content: Array<{
              output: { type: string; value: string };
            }>;
          }
        | undefined;
      assert.ok(toolMsg);
      assert.equal(toolMsg.content[0]?.output.type, "error-text");
      assert.match(toolMsg.content[0]?.output.value ?? "", /intentional/);
      sawFailure = true;
      return {
        stream: simulateReadableStream({ chunks: textChunks("handled") }),
      };
    },
  });

  const events: string[] = [];
  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "fail" }],
    tools: {
      boom: tool({
        description: "fails",
        inputSchema: emptyObjectSchema,
        execute: async (): Promise<{ ok: true }> => {
          throw new Error("intentional failure");
        },
      }),
    },
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(sawFailure, true);
  assert.ok(events.includes("tool_failed"));
  assert.ok(!events.includes("tool_completed"));
  assert.equal(result.text, "handled");
});

test("TEST E — maxTurns counts model invocations", async () => {
  let invocations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      return {
        stream: simulateReadableStream({
          chunks: toolCallChunks([
            { id: `t${invocations}`, name: "noop", input: {} },
          ]),
        }),
      };
    },
  });

  await assert.rejects(
    () =>
      runAgent({
        model,
        messages: [{ role: "user", content: "loop" }],
        maxTurns: 3,
        tools: {
          noop: tool({
            description: "noop",
            inputSchema: emptyObjectSchema,
            execute: async () => ({ ok: true }),
          }),
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof MaxTurnsExceededError);
      assert.equal(error.maxTurns, 3);
      return true;
    },
  );
  assert.equal(invocations, 3);
});

test("TEST F — abort stops cleanly", async () => {
  const abort = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      abort.abort();
      return {
        stream: simulateReadableStream({
          chunks: textChunks("should not finish"),
        }),
      };
    },
  });

  const events: string[] = [];
  await assert.rejects(() =>
    runAgent({
      model,
      messages: [{ role: "user", content: "stop" }],
      signal: abort.signal,
      onEvent: (event) => {
        events.push(event.type);
      },
    }),
  );
  assert.ok(events.includes("cancelled") || events.includes("started"));
});

test("runAgent relays Phase 0 event sequence when no tools", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks("Hello") }),
    }),
  });
  const events: string[] = [];

  await runAgent({
    model,
    messages: [{ role: "user", content: "Say hello" }],
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  assert.deepEqual(events, ["started", "text_delta", "completed"]);
});
