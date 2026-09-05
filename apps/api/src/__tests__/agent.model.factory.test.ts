import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCoreError } from "@opensuite/agent-core";

import {
  createConfiguredAgentModel,
  createDevelopmentFakeAgentModel,
  createUnconfiguredAgentModel,
} from "../agent/model/index.js";
import type { AnthropicMessagesClient } from "../agent/model/anthropic.js";
import type { OpenAIResponsesClient } from "../agent/model/openai.js";
import type { OpenAIChatCompletionsClient } from "../agent/model/openrouter.js";

const emptyKeys = {
  anthropicApiKey: null as string | null,
  anthropicModel: "claude-sonnet-4-5",
  openaiApiKey: null as string | null,
  openaiModel: "gpt-4.1",
  openrouterApiKey: null as string | null,
  openrouterModel: null as string | null,
};

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

test("createConfiguredAgentModel selects fake, openai, and openrouter", async () => {
  const fake = createConfiguredAgentModel({
    nodeEnv: "development",
    agent: { ...emptyKeys, provider: "fake" },
  });
  const fakeResult = await fake.complete({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });
  assert.match(fakeResult.content, /fake model/i);

  const openaiClient: OpenAIResponsesClient = {
    responses: {
      async create() {
        return {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "From OpenAI" }],
            },
          ],
        };
      },
    },
  };
  const openai = createConfiguredAgentModel(
    {
      nodeEnv: "development",
      agent: {
        ...emptyKeys,
        provider: "openai",
        openaiApiKey: "test-key",
        openaiModel: "gpt-test",
      },
    },
    { openaiClient },
  );
  assert.equal(
    (
      await openai.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      })
    ).content,
    "From OpenAI",
  );

  const openrouterClient: OpenAIChatCompletionsClient = {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: "From OpenRouter" } }] };
        },
      },
    },
  };
  const openrouter = createConfiguredAgentModel(
    {
      nodeEnv: "development",
      agent: {
        ...emptyKeys,
        provider: "openrouter",
        openrouterApiKey: "or-key",
        openrouterModel: "meta-llama/test",
      },
    },
    { openrouterClient },
  );
  assert.equal(
    (
      await openrouter.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      })
    ).content,
    "From OpenRouter",
  );

  const anthropicClient: AnthropicMessagesClient = {
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
        ...emptyKeys,
        provider: "anthropic",
        anthropicApiKey: "test-key",
        anthropicModel: "claude-test",
      },
    },
    { anthropicClient },
  );
  assert.equal(
    (
      await anthropic.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      })
    ).content,
    "From Anthropic",
  );
});
