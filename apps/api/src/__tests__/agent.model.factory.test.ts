import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCoreError } from "@opensuite/agent-core";

import {
  createConfiguredAgentModel,
  createDevelopmentFakeAgentModel,
  createUnconfiguredAgentModel,
} from "../agent/model/index.js";
import type { AnthropicMessagesClient } from "../agent/model/anthropic.js";

test("unconfigured model fails safely", async () => {
  const model = createUnconfiguredAgentModel();
  await assert.rejects(
    () => model.complete({ messages: [], tools: [] }),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.code === "MODEL_FAILURE" &&
      error.message.includes("not configured"),
  );
});

test("fake development model returns deterministic text", async () => {
  const model = createDevelopmentFakeAgentModel();
  const result = await model.complete({
    messages: [{ role: "user", content: "Summarize this doc" }],
    tools: [],
  });
  assert.match(result.content, /fake model/i);
  assert.match(result.content, /Summarize this doc/);
  assert.deepEqual(result.toolCalls, []);
});

test("createConfiguredAgentModel selects fake and anthropic", async () => {
  const fake = createConfiguredAgentModel({
    nodeEnv: "development",
    agent: {
      provider: "fake",
      anthropicApiKey: null,
      anthropicModel: "claude-sonnet-4-5",
    },
  });
  const fakeResult = await fake.complete({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });
  assert.match(fakeResult.content, /fake model/i);

  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        return { content: [{ type: "text", text: "From Anthropic" }] };
      },
    },
  };
  const anthropic = createConfiguredAgentModel(
    {
      nodeEnv: "development",
      agent: {
        provider: "anthropic",
        anthropicApiKey: "test-key",
        anthropicModel: "claude-test",
      },
    },
    { anthropicClient: client },
  );
  const result = await anthropic.complete({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
  });
  assert.equal(result.content, "From Anthropic");
});
