import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCoreError } from "@opensuite/agent-core";

import {
  createAnthropicAgentModel,
  fromAnthropicMessage,
  normalizeProviderError,
  toAnthropicMessages,
  toAnthropicTool,
  type AnthropicMessage,
  type AnthropicMessagesClient,
  type AnthropicMessagesCreateParams,
} from "../agent/model/anthropic.js";

function mockClient(
  handler: (
    params: AnthropicMessagesCreateParams,
    options?: { signal?: AbortSignal },
  ) => Promise<AnthropicMessage>,
): AnthropicMessagesClient {
  return {
    messages: {
      create: handler,
    },
  };
}

test("toAnthropicTool maps provider-neutral schemas", () => {
  assert.deepEqual(
    toAnthropicTool({
      name: "document.inspect",
      description: "Inspect a document",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }),
    {
      name: "document.inspect",
      description: "Inspect a document",
      input_schema: {
        type: "object",
        properties: { q: { type: "string" } },
      },
    },
  );
});

test("toAnthropicMessages collapses consecutive tool results", () => {
  const mapped = toAnthropicMessages([
    { role: "user", content: "Inspect please" },
    {
      role: "assistant",
      content: "Working",
      toolCalls: [
        { id: "t1", name: "document.inspect", input: { q: "x" } },
        { id: "t2", name: "document.inspect", input: { q: "y" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "t1",
      toolName: "document.inspect",
      status: "succeeded",
      summary: "ok1",
    },
    {
      role: "tool",
      toolCallId: "t2",
      toolName: "document.inspect",
      status: "failed",
      summary: "bad",
    },
    { role: "assistant", content: "Done" },
  ]);

  assert.equal(mapped.length, 4);
  assert.equal(mapped[0]?.role, "user");
  assert.equal(mapped[1]?.role, "assistant");
  assert.equal(mapped[2]?.role, "user");
  assert.ok(Array.isArray(mapped[2]?.content));
  const toolResults = mapped[2]!.content as Array<{ type: string }>;
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0]?.type, "tool_result");
  assert.equal(mapped[3]?.role, "assistant");
});

test("fromAnthropicMessage extracts text and tool calls", () => {
  const response = fromAnthropicMessage({
    content: [
      { type: "text", text: "Hello" },
      {
        type: "tool_use",
        id: "call_1",
        name: "document.inspect",
        input: { q: "board" },
      },
      {
        type: "tool_use",
        id: "call_2",
        name: "document.inspect",
        input: {},
      },
    ],
  });

  assert.equal(response.content, "Hello");
  assert.deepEqual(response.toolCalls, [
    { id: "call_1", name: "document.inspect", input: { q: "board" } },
    { id: "call_2", name: "document.inspect", input: {} },
  ]);
});

test("Anthropic adapter: text-only response", async () => {
  const model = createAnthropicAgentModel({
    model: "claude-test",
    client: mockClient(async () => ({
      content: [{ type: "text", text: "Plain answer" }],
    })),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
  });
  assert.deepEqual(result, { content: "Plain answer", toolCalls: [] });
});

test("Anthropic adapter: one tool call", async () => {
  const model = createAnthropicAgentModel({
    model: "claude-test",
    client: mockClient(async (params) => {
      assert.equal(params.tools?.length, 1);
      assert.equal(params.tools?.[0]?.name, "document.inspect");
      return {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "document.inspect",
            input: { q: "x" },
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
  assert.equal(result.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.id, "toolu_1");
});

test("Anthropic adapter: multiple tool calls", async () => {
  const model = createAnthropicAgentModel({
    model: "claude-test",
    client: mockClient(async () => ({
      content: [
        { type: "text", text: "Calling tools" },
        {
          type: "tool_use",
          id: "a",
          name: "document.inspect",
          input: { n: 1 },
        },
        {
          type: "tool_use",
          id: "b",
          name: "document.inspect",
          input: { n: 2 },
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

test("Anthropic adapter: tool-result continuation reaches provider", async () => {
  let sawToolResult = false;
  const model = createAnthropicAgentModel({
    model: "claude-test",
    client: mockClient(async (params) => {
      const last = params.messages[params.messages.length - 1];
      assert.equal(last?.role, "user");
      assert.ok(Array.isArray(last?.content));
      const blocks = last!.content as Array<{ type: string }>;
      sawToolResult = blocks.some((b) => b.type === "tool_result");
      return { content: [{ type: "text", text: "Continued" }] };
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
  assert.equal(sawToolResult, true);
  assert.equal(result.content, "Continued");
});

test("Anthropic adapter: cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = createAnthropicAgentModel({
    model: "claude-test",
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

test("Anthropic adapter: mid-flight abort maps to CANCELLED", async () => {
  const model = createAnthropicAgentModel({
    model: "claude-test",
    client: mockClient(async (_params, options) => {
      const err = new Error("aborted");
      err.name = "APIUserAbortError";
      options?.signal?.throwIfAborted?.();
      throw err;
    }),
  });

  const controller = new AbortController();
  const pending = model.complete({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "CANCELLED",
  );
});

test("normalizeProviderError hides provider internals", () => {
  const normalized = normalizeProviderError(
    {
      status: 401,
      message: "invalid x-api-key sk-ant-secret",
      error: { type: "authentication_error" },
    },
    "Anthropic",
  );
  assert.equal(normalized.code, "MODEL_FAILURE");
  assert.equal(normalized.message, "Anthropic authentication failed");
  assert.equal(normalized.message.includes("sk-ant"), false);
});
