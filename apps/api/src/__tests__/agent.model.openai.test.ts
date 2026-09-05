import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCoreError } from "@opensuite/agent-core";

import {
  createOpenAIAgentModel,
  fromOpenAIResponsesResult,
  toOpenAIResponsesInput,
  toOpenAIResponsesTool,
  type OpenAIResponsesClient,
  type OpenAIResponsesCreateParams,
  type OpenAIResponsesResult,
} from "../agent/model/openai.js";
import { normalizeProviderError } from "../agent/model/shared.js";

function mockClient(
  handler: (
    params: OpenAIResponsesCreateParams,
    options?: { signal?: AbortSignal },
  ) => Promise<OpenAIResponsesResult>,
): OpenAIResponsesClient {
  return {
    responses: {
      create: handler,
    },
  };
}

test("toOpenAIResponsesTool maps provider-neutral schemas", () => {
  assert.deepEqual(
    toOpenAIResponsesTool({
      name: "document.inspect",
      description: "Inspect",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }),
    {
      type: "function",
      name: "document.inspect",
      description: "Inspect",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
      },
    },
  );
});

test("toOpenAIResponsesInput maps tool calls and results", () => {
  const input = toOpenAIResponsesInput([
    { role: "user", content: "Inspect please" },
    {
      role: "assistant",
      content: "Working",
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

  assert.ok(input[0] && "role" in input[0] && input[0].role === "user");
  assert.ok(input[1] && "role" in input[1] && input[1].role === "assistant");
  assert.equal(
    (input[2] as { type: string; call_id: string }).type,
    "function_call",
  );
  assert.equal(
    (input[3] as { type: string; call_id: string }).type,
    "function_call_output",
  );
});

test("fromOpenAIResponsesResult extracts text and tool calls", () => {
  const response = fromOpenAIResponsesResult({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "document.inspect",
        arguments: "{\"q\":\"board\"}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "document.inspect",
        arguments: "{}",
      },
    ],
  });

  assert.equal(response.content, "Hello");
  assert.equal(response.toolCalls.length, 2);
  assert.equal(response.toolCalls[0]?.id, "call_1");
});

test("OpenAI adapter: text-only response", async () => {
  const model = createOpenAIAgentModel({
    model: "gpt-test",
    client: mockClient(async () => ({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Plain answer" }],
        },
      ],
    })),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
  });
  assert.deepEqual(result, { content: "Plain answer", toolCalls: [] });
});

test("OpenAI adapter: one tool call", async () => {
  const model = createOpenAIAgentModel({
    model: "gpt-test",
    client: mockClient(async (params) => {
      assert.equal(params.tools?.length, 1);
      return {
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "document.inspect",
            arguments: "{\"q\":\"x\"}",
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

test("OpenAI adapter: multiple tool calls", async () => {
  const model = createOpenAIAgentModel({
    model: "gpt-test",
    client: mockClient(async () => ({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Calling tools" }],
        },
        {
          type: "function_call",
          call_id: "a",
          name: "document.inspect",
          arguments: "{\"n\":1}",
        },
        {
          type: "function_call",
          call_id: "b",
          name: "document.inspect",
          arguments: "{\"n\":2}",
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

test("OpenAI adapter: tool-result continuation reaches provider", async () => {
  let sawToolOutput = false;
  const model = createOpenAIAgentModel({
    model: "gpt-test",
    client: mockClient(async (params) => {
      sawToolOutput = params.input.some(
        (item) =>
          "type" in item && item.type === "function_call_output",
      );
      return {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Continued" }],
          },
        ],
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
  assert.equal(sawToolOutput, true);
  assert.equal(result.content, "Continued");
});

test("OpenAI adapter: cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = createOpenAIAgentModel({
    model: "gpt-test",
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

test("OpenAI adapter: provider error normalization", async () => {
  const model = createOpenAIAgentModel({
    model: "gpt-test",
    client: mockClient(async () => {
      throw { status: 429, message: "rate limit hit with secret key sk-xyz" };
    }),
  });

  await assert.rejects(
    () =>
      model.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      }),
    (error: unknown) =>
      error instanceof AgentCoreError &&
      error.code === "MODEL_FAILURE" &&
      error.message === "OpenAI rate limit exceeded" &&
      !error.message.includes("sk-xyz"),
  );

  const normalized = normalizeProviderError(
    { status: 401, message: "bad key" },
    "OpenAI",
  );
  assert.equal(normalized.message, "OpenAI authentication failed");
});
