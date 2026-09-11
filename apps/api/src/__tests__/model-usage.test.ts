import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  AgentCoreError,
  createFakeAgentModel,
  type AgentModel,
  type ModelRequest,
  type ModelResponse,
  type ModelTokenUsage,
} from "@opensuite/agent-core";

import {
  createAnthropicAgentModel,
  type AnthropicMessage,
  type AnthropicMessagesClient,
} from "../agent/model/anthropic.js";
import {
  createOpenAIAgentModel,
  type OpenAIResponsesClient,
  type OpenAIResponsesResult,
} from "../agent/model/openai.js";
import {
  createOpenRouterAgentModel,
  type OpenAIChatCompletionsClient,
  type OpenAIChatCompletion,
} from "../agent/model/openrouter.js";
import { createMeteredAgentModel } from "../model-usage/meter.js";
import type { ModelUsageRepository } from "../model-usage/repository.js";
import {
  createModelUsageService,
  normalizeModelUsageTokens,
} from "../model-usage/service.js";
import type {
  ModelUsageAggregate,
  ModelUsageEvent,
  RecordModelUsageInput,
} from "../model-usage/types.js";

class MemoryModelUsageRepository implements ModelUsageRepository {
  readonly events: ModelUsageEvent[] = [];

  async insert(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
    const event: ModelUsageEvent = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      credentialSource: input.credentialSource,
      inputTokens: input.tokens.inputTokens,
      outputTokens: input.tokens.outputTokens,
      cachedInputTokens: input.tokens.cachedInputTokens,
      reasoningTokens: input.tokens.reasoningTokens,
      agentRunId: input.agentRunId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async listForUser(input: {
    userId: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ModelUsageEvent[]> {
    return this.events
      .filter((event) => event.userId === input.userId)
      .filter((event) => {
        const at = new Date(event.createdAt).getTime();
        if (input.from && at < input.from.getTime()) return false;
        if (input.to && at > input.to.getTime()) return false;
        return true;
      })
      .slice(0, input.limit ?? 100);
  }

  async aggregateForUser(input: {
    userId: string;
    from?: Date;
    to?: Date;
  }): Promise<ModelUsageAggregate> {
    const events = await this.listForUser(input);
    return {
      eventCount: events.length,
      inputTokens: events.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0),
      outputTokens: events.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0),
      cachedInputTokens: events.reduce(
        (sum, e) => sum + (e.cachedInputTokens ?? 0),
        0,
      ),
      reasoningTokens: events.reduce(
        (sum, e) => sum + (e.reasoningTokens ?? 0),
        0,
      ),
    };
  }
}

function scriptedModel(
  respond: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): AgentModel {
  return {
    async complete(request) {
      return respond(request);
    },
  };
}

function usageMeta(usage: ModelTokenUsage): ModelResponse["meta"] {
  return {
    provider: "openai",
    modelId: "gpt-test",
    usage,
  };
}

test("normalizeModelUsageTokens preserves provider values and leaves gaps null", () => {
  assert.deepEqual(normalizeModelUsageTokens(undefined), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
  assert.deepEqual(
    normalizeModelUsageTokens({ inputTokens: 10, outputTokens: 0 }),
    {
      inputTokens: 10,
      outputTokens: 0,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  );
});

test("successful model call records one usage event with trusted attribution", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  const model = createMeteredAgentModel(
    scriptedModel(async () => ({
      content: "ok",
      toolCalls: [],
      meta: usageMeta({ inputTokens: 12, outputTokens: 4 }),
    })),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "gpt-4o-mini",
        credentialSource: "managed",
        agentRunId: "run-1",
      },
      usage,
    },
  );

  await model.complete({
    messages: [{ role: "user", content: "secret prompt" }],
    tools: [],
  });

  assert.equal(repo.events.length, 1);
  const event = repo.events[0]!;
  assert.equal(event.userId, "user-a");
  assert.equal(event.provider, "openai");
  assert.equal(event.model, "gpt-4o-mini");
  assert.equal(event.credentialSource, "managed");
  assert.equal(event.inputTokens, 12);
  assert.equal(event.outputTokens, 4);
  assert.equal(event.agentRunId, "run-1");
  assert.equal(
    JSON.stringify(event).includes("secret prompt"),
    false,
    "usage rows must not contain prompts",
  );
  assert.equal(JSON.stringify(event).includes("sk-"), false);
});

test("BYOK and managed events remain distinguishable", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);

  for (const credentialSource of ["byok", "managed"] as const) {
    const model = createMeteredAgentModel(
      scriptedModel(async () => ({
        content: "ok",
        toolCalls: [],
        meta: usageMeta({ inputTokens: 1, outputTokens: 1 }),
      })),
      {
        attribution: {
          userId: "user-a",
          provider: "anthropic",
          model: "claude-sonnet",
          credentialSource,
        },
        usage,
      },
    );
    await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  }

  assert.equal(repo.events.length, 2);
  assert.equal(repo.events[0]?.credentialSource, "byok");
  assert.equal(repo.events[1]?.credentialSource, "managed");
  assert.notEqual(
    repo.events[0]?.credentialSource,
    repo.events[1]?.credentialSource,
  );
});

test("multiple provider calls create separate events; one call does not duplicate", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  let calls = 0;
  const model = createMeteredAgentModel(
    scriptedModel(async () => {
      calls += 1;
      return {
        content: `n=${calls}`,
        toolCalls: [],
        meta: usageMeta({ inputTokens: calls, outputTokens: 1 }),
      };
    }),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "gpt-test",
        credentialSource: "managed",
      },
      usage,
    },
  );

  await model.complete({ messages: [{ role: "user", content: "a" }], tools: [] });
  await model.complete({ messages: [{ role: "user", content: "b" }], tools: [] });
  assert.equal(repo.events.length, 2);
  assert.equal(repo.events[0]?.inputTokens, 1);
  assert.equal(repo.events[1]?.inputTokens, 2);
});

test("streaming/chunking does not create multiple usage events", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  const base = createFakeAgentModel({
    respond: () => ({
      content: "Hello world!!", // >12 chars → multiple onTextDelta chunks
      toolCalls: [],
      meta: usageMeta({ inputTokens: 5, outputTokens: 3 }),
    }),
  });
  const model = createMeteredAgentModel(base, {
    attribution: {
      userId: "user-a",
      provider: "openai",
      model: "gpt-test",
      credentialSource: "managed",
    },
    usage,
  });

  const deltas: string[] = [];
  await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onTextDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.ok(deltas.length > 1, "fake model should stream multiple chunks");
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.inputTokens, 5);
  assert.equal(repo.events[0]?.outputTokens, 3);
});

test("failed calls without trustworthy usage do not fabricate usage", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  const model = createMeteredAgentModel(
    {
      async complete() {
        throw new AgentCoreError("MODEL_FAILURE", "provider down");
      },
    },
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "gpt-test",
        credentialSource: "managed",
      },
      usage,
    },
  );

  await assert.rejects(
    () =>
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    /provider down/,
  );
  assert.equal(repo.events.length, 0);
});

test("one user cannot read another user's usage through domain read APIs", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  await usage.record({
    userId: "user-a",
    provider: "openai",
    model: "gpt-test",
    credentialSource: "managed",
    tokens: {
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  });
  await usage.record({
    userId: "user-b",
    provider: "openai",
    model: "gpt-test",
    credentialSource: "byok",
    tokens: {
      inputTokens: 99,
      outputTokens: 9,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  });

  const listed = await usage.listForUser({ userId: "user-a" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.userId, "user-a");
  assert.equal(listed[0]?.inputTokens, 10);

  const aggregate = await usage.aggregateForUser({ userId: "user-a" });
  assert.equal(aggregate.eventCount, 1);
  assert.equal(aggregate.inputTokens, 10);
  assert.equal(aggregate.outputTokens, 2);
});

test("Anthropic usage normalization works (including streaming finalMessage)", async () => {
  const raw: AnthropicMessage = {
    content: [{ type: "text", text: "Hi" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    },
  };
  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        return raw;
      },
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Hi" },
            };
          },
          async finalMessage() {
            return raw;
          },
        };
      },
    },
  };
  const model = createAnthropicAgentModel({
    client,
    model: "claude-test",
  });

  const streamed = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onTextDelta: () => undefined,
  });
  assert.deepEqual(streamed.meta?.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cachedInputTokens: 3,
  });

  const nonStream = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.deepEqual(nonStream.meta?.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cachedInputTokens: 3,
  });
});

test("OpenAI usage normalization works", async () => {
  const result: OpenAIResponsesResult = {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello" }],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
    status: "completed",
  };
  const client: OpenAIResponsesClient = {
    responses: {
      async create(params) {
        if (params.stream) {
          async function* events() {
            yield {
              type: "response.output_text.delta" as const,
              delta: "Hello",
            };
            yield {
              type: "response.completed" as const,
              response: result,
            };
          }
          return events();
        }
        return result;
      },
    },
  };
  const model = createOpenAIAgentModel({ client, model: "gpt-test" });

  const response = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onTextDelta: () => undefined,
  });
  assert.deepEqual(response.meta?.usage, {
    inputTokens: 11,
    outputTokens: 2,
    cachedInputTokens: 4,
    reasoningTokens: 1,
  });
});

test("OpenRouter usage normalization works (stream include_usage)", async () => {
  const completion: OpenAIChatCompletion = {
    choices: [
      {
        message: { content: "Hello" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  };
  const client: OpenAIChatCompletionsClient = {
    chat: {
      completions: {
        async create(params) {
          if (params.stream) {
            assert.equal(params.stream_options?.include_usage, true);
            async function* chunks() {
              yield { choices: [{ delta: { content: "Hel" } }] };
              yield { choices: [{ delta: { content: "lo" } }] };
              yield {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: completion.usage,
              };
            }
            return chunks();
          }
          return completion;
        },
      },
    },
  };
  const model = createOpenRouterAgentModel({
    client,
    model: "meta-llama/test",
  });

  const streamed = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onTextDelta: () => undefined,
  });
  assert.deepEqual(streamed.meta?.usage, {
    inputTokens: 8,
    outputTokens: 3,
    cachedInputTokens: 1,
    reasoningTokens: 2,
  });

  const nonStream = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.deepEqual(nonStream.meta?.usage, {
    inputTokens: 8,
    outputTokens: 3,
    cachedInputTokens: 1,
    reasoningTokens: 2,
  });
});

test("metered fake model path stays deterministic and records without fabricated tokens", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo);
  const model = createMeteredAgentModel(
    createFakeAgentModel({
      respond: () => ({
        content: "Understood. (fake model)",
        toolCalls: [],
      }),
    }),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "fake",
        credentialSource: "managed",
      },
      usage,
    },
  );

  const response = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.match(response.content, /fake model/);
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.inputTokens, null);
  assert.equal(repo.events[0]?.outputTokens, null);
});

test("usage persistence failure does not fail a successful provider call", async () => {
  const usage = createModelUsageService({
    async insert() {
      throw new Error("db down");
    },
    async listForUser() {
      return [];
    },
    async aggregateForUser() {
      return {
        eventCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      };
    },
  });
  const errors: unknown[] = [];
  const model = createMeteredAgentModel(
    scriptedModel(async () => ({
      content: "ok",
      toolCalls: [],
      meta: usageMeta({ inputTokens: 1, outputTokens: 1 }),
    })),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "gpt-test",
        credentialSource: "managed",
      },
      usage,
      onRecordError: (error) => errors.push(error),
    },
  );

  const response = await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.equal(response.content, "ok");
  assert.equal(errors.length, 1);
});
