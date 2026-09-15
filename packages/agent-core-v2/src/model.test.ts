import assert from "node:assert/strict";
import { test } from "node:test";

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { runModel } from "./model.js";

test("runModel streams text and returns the final response", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Hello " },
          { type: "text-delta", id: "text", delta: "OpenSuite" },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ],
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

  assert.deepEqual(deltas, ["Hello ", "OpenSuite"]);
  assert.equal(result.text, "Hello OpenSuite");
  assert.equal(result.inputTokens, 3);
  assert.equal(result.outputTokens, 2);
});
