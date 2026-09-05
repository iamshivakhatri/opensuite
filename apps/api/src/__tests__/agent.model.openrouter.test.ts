import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCoreError } from "@opensuite/agent-core";

import {
  createOpenRouterAgentModel,
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
  toOpenAIChatTool,
  type OpenAIChatCompletionsClient,
  type OpenAIChatCompletionsCreateParams,
  type OpenAIChatCompletion,
} from "../agent/model/openrouter.js";
import { normalizeProviderError } from "../agent/model/shared.js";

function mockClient(
  handler: (
    params: OpenAIChatCompletionsCreateParams,
    options?: { signal?: AbortSignal },
  ) => Promise<OpenAIChatCompletion>,
): OpenAIChatCompletionsClient {
  return {
    chat: {
      completions: {
        create: handler,
      },
    },
  };
}

test("toOpenAIChatTool maps provider-neutral schemas", () => {
  assert.deepEqual(
    toOpenAIChatTool({
      name: "document.inspect",
      description: "Inspect",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }),
    {
      type: "function",
      function: {
        name: "document.inspect",
        description: "Inspect",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    },
  );
});

test("toOpenAIChatMessages maps tool calls and results", () => {
  const messages = toOpenAIChatMessages([
    { role: "user", content: "Inspect please" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "document.inspect", input: { q: "x" } }],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      toolName: "document.inspect",
      status: "succeeded",
      summary: "ok",
    },
  ]);

  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
  assert.ok("tool_calls" in messages[1]!);
  assert.equal(messages[2]?.role, "tool");
});

test("fromOpenAIChatCompletion extracts text and tool calls", () => {
  const response = fromOpenAIChatCompletion({
    choices: [
      {
        message: {
          content: "Hello",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "document.inspect",
                arguments: "{\"q\":\"board\"}",
              },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "document.inspect", arguments: "{}" },
            },
          ],
        },
      },
    ],
  });

  assert.equal(response.content, "Hello");
  assert.equal(response.toolCalls.length, 2);
});

test("OpenRouter adapter: text-only response", async () => {
  const model = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async () => ({
      choices: [{ message: { content: "Plain answer" } }],
    })),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
  });
  assert.deepEqual(result, { content: "Plain answer", toolCalls: [] });
});

test("OpenRouter adapter: one tool call", async () => {
  const model = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async (params) => {
      assert.equal(params.tools?.length, 1);
      assert.equal(params.model, "meta-llama/test");
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "document.inspect",
                    arguments: "{\"q\":\"x\"}",
                  },
                },
              ],
            },
          },
        ],
      };
    }),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "Inspect" }],
    tools: [
      {
        name: "document.inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.id, "call_1");
});

test("OpenRouter adapter: multiple tool calls", async () => {
  const model = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async () => ({
      choices: [
        {
          message: {
            content: "Calling tools",
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: {
                  name: "document.inspect",
                  arguments: "{\"n\":1}",
                },
              },
              {
                id: "b",
                type: "function",
                function: {
                  name: "document.inspect",
                  arguments: "{\"n\":2}",
                },
              },
            ],
          },
        },
      ],
    })),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "Go" }],
    tools: [
      {
        name: "document.inspect",
        description: "Inspect",
        inputSchema: { type: "object" },
      },
    ],
  });
  assert.equal(result.content, "Calling tools");
  assert.equal(result.toolCalls.length, 2);
});

test("OpenRouter adapter: tool-result continuation reaches provider", async () => {
  let sawToolMessage = false;
  const model = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async (params) => {
      sawToolMessage = params.messages.some((m) => m.role === "tool");
      return {
        choices: [{ message: { content: "Continued" } }],
      };
    }),
  });

  const result = await model.complete({
    messages: [
      { role: "user", content: "Inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "document.inspect", input: {} }],
      },
      {
        role: "tool",
        toolCallId: "t1",
        toolName: "document.inspect",
        status: "succeeded",
        summary: "looked",
      },
    ],
    tools: [],
  });
  assert.equal(sawToolMessage, true);
  assert.equal(result.content, "Continued");
});

test("OpenRouter adapter: cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async () => {
      throw new Error("should not be called");
    }),
  });

  await assert.rejects(
    () =>
      model.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        signal: controller.signal,
      }),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "CANCELLED",
  );
});

test("OpenRouter adapter: provider error and unsupported tools", async () => {
  const rateLimited = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async () => {
      throw { status: 429, message: "rate limit" };
    }),
  });
  await assert.rejects(
    () =>
      rateLimited.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      }),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.message === "OpenRouter rate limit exceeded",
  );

  const noTools = createOpenRouterAgentModel({
    model: "meta-llama/test",
    client: mockClient(async () => {
      throw {
        status: 400,
        message: "This model does not support tool use",
      };
    }),
  });
  await assert.rejects(
    () =>
      noTools.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "document.inspect",
            description: "Inspect",
            inputSchema: { type: "object" },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.message === "OpenRouter model does not support tool calling",
  );

  const normalized = normalizeProviderError(
    { status: 401, message: "bad key" },
    "OpenRouter",
  );
  assert.equal(normalized.message, "OpenRouter authentication failed");
});
