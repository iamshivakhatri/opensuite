import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  assistantOnlyResponse,
  createFakeAgentModel,
  toolCallResponse,
} from "../index.js";

test("FakeAgentModel returns assistant output", async () => {
  const model = createFakeAgentModel({
    respond: assistantOnlyResponse("Done."),
  });
  const response = await model.complete({
    messages: [{ role: "user", content: "Rewrite the intro" }],
    tools: [],
  });
  assert.equal(response.content, "Done.");
  assert.deepEqual(response.toolCalls, []);
});

test("FakeAgentModel can return one tool call", async () => {
  const model = createFakeAgentModel({
    respond: toolCallResponse("Inspecting…", [
      {
        id: "call-1",
        name: "document.inspect",
        input: {},
      },
    ]),
  });
  const response = await model.complete({
    messages: [{ role: "user", content: "Look at this" }],
    tools: [
      {
        name: "document.inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
  });
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "document.inspect");
});

test("FakeAgentModel can return multiple tool calls", async () => {
  const model = createFakeAgentModel({
    respond: toolCallResponse("", [
      { id: "a", name: "document.inspect", input: {} },
      { id: "b", name: "research.web_search", input: { q: "x" } },
    ]),
  });
  const response = await model.complete({
    messages: [{ role: "user", content: "Do both" }],
    tools: [],
  });
  assert.equal(response.toolCalls.length, 2);
  assert.deepEqual(
    response.toolCalls.map((call) => call.id),
    ["a", "b"],
  );
});

test("FakeAgentModel respects AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = createFakeAgentModel({
    respond: assistantOnlyResponse("nope"),
  });
  await assert.rejects(
    () =>
      model.complete({
        messages: [],
        tools: [],
        signal: controller.signal,
      }),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "CANCELLED",
  );
});
