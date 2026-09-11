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
import {
  createModelPricingRegistry,
  estimateModelCost,
  PRODUCTION_MODEL_PRICING,
  tokensCostMicros,
  type ModelPricingEntry,
} from "../model-usage/pricing.js";
import type { ModelUsageRepository } from "../model-usage/repository.js";
import {
  createModelUsageService,
  normalizeModelUsageTokens,
} from "../model-usage/service.js";
import type {
  ModelUsageAggregate,
  ModelUsageCostAggregate,
  ModelUsageEvent,
  RecordModelUsageInput,
} from "../model-usage/types.js";

/** Test-only prices — not production. Rates are micro-USD per 1M tokens. */
const FIXTURE_ANTHROPIC: ModelPricingEntry = {
  provider: "anthropic",
  model: "claude-test-priced",
  pricingVersion: "test-fixture-v1",
  currency: "USD",
  inputMicrosPerMTok: 3_000_000, // $3 / MTok
  outputMicrosPerMTok: 15_000_000, // $15 / MTok
  cachedInputMicrosPerMTok: 300_000, // $0.30 / MTok
  cachedInputBilling: "anthropic_separate",
};

const FIXTURE_OPENAI: ModelPricingEntry = {
  provider: "openai",
  model: "gpt-test-priced",
  pricingVersion: "test-fixture-v1",
  currency: "USD",
  inputMicrosPerMTok: 2_000_000,
  outputMicrosPerMTok: 8_000_000,
  cachedInputMicrosPerMTok: 500_000,
  cachedInputBilling: "openai_inclusive",
};

const FIXTURE_OPENROUTER: ModelPricingEntry = {
  provider: "openrouter",
  model: "acme/exact-priced-model",
  pricingVersion: "test-fixture-v1",
  currency: "USD",
  inputMicrosPerMTok: 1_000_000,
  outputMicrosPerMTok: 2_000_000,
  cachedInputMicrosPerMTok: 100_000,
  cachedInputBilling: "openai_inclusive",
};

const TEST_PRICING = createModelPricingRegistry([
  FIXTURE_ANTHROPIC,
  FIXTURE_OPENAI,
  FIXTURE_OPENROUTER,
]);

class MemoryModelUsageRepository implements ModelUsageRepository {
  readonly events: ModelUsageEvent[] = [];

  async insert(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
    const cost = input.cost ?? {
      costMicros: null,
      costCurrency: null,
      costSource: null,
    };
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
      costMicros: cost.costMicros,
      costCurrency: cost.costCurrency,
      costSource: cost.costSource,
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

  async aggregateCostForUser(input: {
    userId: string;
    from?: Date;
    to?: Date;
    credentialSource?: ModelUsageEvent["credentialSource"];
  }): Promise<ModelUsageCostAggregate> {
    let events = await this.listForUser(input);
    if (input.credentialSource) {
      events = events.filter(
        (event) => event.credentialSource === input.credentialSource,
      );
    }
    const bucket = () => ({
      eventCount: 0,
      pricedEventCount: 0,
      costMicros: null as number | null,
    });
    const byok = bucket();
    const managed = bucket();
    let pricedEventCount = 0;
    let currency: string | null = null;
    for (const event of events) {
      const target = event.credentialSource === "byok" ? byok : managed;
      target.eventCount += 1;
      if (event.costMicros !== null) {
        target.pricedEventCount += 1;
        pricedEventCount += 1;
        target.costMicros =
          (target.costMicros ?? 0) + event.costMicros;
        currency ??= event.costCurrency;
      }
    }
    return {
      eventCount: events.length,
      pricedEventCount,
      unpricedEventCount: events.length - pricedEventCount,
      costMicros:
        pricedEventCount > 0
          ? (byok.costMicros ?? 0) +
            (managed.costMicros ?? 0)
          : null,
      costCurrency: pricedEventCount > 0 ? currency : null,
      byCredentialSource: { byok, managed },
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

function usageService(repo: MemoryModelUsageRepository) {
  return createModelUsageService(repo, { pricing: TEST_PRICING });
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
  const usage = usageService(repo);
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
  assert.equal(event.costMicros, null);
  assert.equal(
    JSON.stringify(event).includes("secret prompt"),
    false,
    "usage rows must not contain prompts",
  );
  assert.equal(JSON.stringify(event).includes("sk-"), false);
});

test("BYOK and managed events remain distinguishable", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);

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
  const usage = usageService(repo);
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
  const usage = usageService(repo);
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
  const usage = usageService(repo);
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
  const usage = usageService(repo);
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
      cost: 0.001234,
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
  assert.equal(streamed.meta?.providerReportedCostUsd, 0.001234);

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
  assert.equal(nonStream.meta?.providerReportedCostUsd, 0.001234);
});

test("metered fake model path stays deterministic and records without fabricated tokens", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);
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
  assert.equal(repo.events[0]?.costMicros, null);
});

test("usage persistence failure does not fail a successful provider call", async () => {
  const usage = createModelUsageService(
    {
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
      async aggregateCostForUser() {
        return {
          eventCount: 0,
          pricedEventCount: 0,
          unpricedEventCount: 0,
          costMicros: null,
          costCurrency: null,
          byCredentialSource: {
            byok: { eventCount: 0, pricedEventCount: 0, costMicros: null },
            managed: {
              eventCount: 0,
              pricedEventCount: 0,
              costMicros: null,
            },
          },
        };
      },
    },
    { pricing: TEST_PRICING },
  );
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

// --- Phase B2: cost attribution ---

test("tokensCostMicros uses exact integer micro-USD arithmetic", () => {
  assert.equal(tokensCostMicros(1_000_000, 3_000_000), 3_000_000);
  assert.equal(tokensCostMicros(500_000, 2_000_000), 1_000_000);
  assert.equal(Number.isInteger(tokensCostMicros(1, 3_000_000)), true);
  assert.equal(typeof tokensCostMicros(1, 3_000_000), "number");
});

test("known OpenAI model + usage produces deterministic estimated cost", () => {
  // input 1000 of which 400 cached → uncached 600
  // 600 * 2e6 / 1e6 + 400 * 5e5 / 1e6 + 200 * 8e6 / 1e6
  // = 1200 + 200 + 1600 = 3000 micros
  const result = estimateModelCost({
    provider: "openai",
    model: "gpt-test-priced",
    tokens: {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
      reasoningTokens: 50,
    },
    pricing: FIXTURE_OPENAI,
  });
  assert.equal(result.status, "priced");
  if (result.status === "priced") {
    assert.equal(result.estimatedCostMicros, 3000);
    assert.equal(result.currency, "USD");
    assert.equal(result.pricingVersion, "test-fixture-v1");
  }
});

test("OpenAI cached input is not double-counted; reasoning is not charged separately", () => {
  const withReasoning = estimateModelCost({
    provider: "openai",
    model: "gpt-test-priced",
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 40,
      reasoningTokens: 30,
    },
    pricing: FIXTURE_OPENAI,
  });
  const withoutReasoning = estimateModelCost({
    provider: "openai",
    model: "gpt-test-priced",
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 40,
      reasoningTokens: null,
    },
    pricing: FIXTURE_OPENAI,
  });
  assert.equal(withReasoning.status, "priced");
  assert.equal(withoutReasoning.status, "priced");
  if (withReasoning.status === "priced" && withoutReasoning.status === "priced") {
    assert.equal(withReasoning.estimatedCostMicros, withoutReasoning.estimatedCostMicros);
    // uncached 60 * 2 + cached 40 * 0.5 + output 50 * 8 = 120 + 20 + 400 = 540
    assert.equal(withReasoning.estimatedCostMicros, 540);
  }
});

test("Anthropic cache-read tokens are billed separately (not subtracted from input)", () => {
  // input 100 + cache_read 50 + output 10
  // 100*3 + 50*0.3 + 10*15 = 300 + 15 + 150 = 465 micros
  const result = estimateModelCost({
    provider: "anthropic",
    model: "claude-test-priced",
    tokens: {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 50,
      reasoningTokens: null,
    },
    pricing: FIXTURE_ANTHROPIC,
  });
  assert.equal(result.status, "priced");
  if (result.status === "priced") {
    assert.equal(result.estimatedCostMicros, 465);
  }

  const naiveDoubleCount = tokensCostMicros(150, 3_000_000) + tokensCostMicros(50, 300_000) + tokensCostMicros(10, 15_000_000);
  assert.notEqual(
    result.status === "priced" ? result.estimatedCostMicros : null,
    naiveDoubleCount,
  );
});

test("unknown model and missing usage leave cost unpriced/null", () => {
  assert.equal(
    estimateModelCost({
      provider: "openai",
      model: "gpt-unknown",
      tokens: {
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      pricing: null,
    }).status,
    "unpriced",
  );
  assert.equal(
    estimateModelCost({
      provider: "openai",
      model: "gpt-test-priced",
      tokens: {
        inputTokens: null,
        outputTokens: 2,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      pricing: FIXTURE_OPENAI,
    }).status,
    "unpriced",
  );
});

test("unknown pricing never prevents raw usage from being recorded", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);
  const model = createMeteredAgentModel(
    scriptedModel(async () => ({
      content: "ok",
      toolCalls: [],
      meta: usageMeta({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 1 }),
    })),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "totally-unknown-model",
        credentialSource: "managed",
      },
      usage,
    },
  );
  await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.inputTokens, 7);
  assert.equal(repo.events[0]?.outputTokens, 3);
  assert.equal(repo.events[0]?.cachedInputTokens, 1);
  assert.equal(repo.events[0]?.costMicros, null);
  assert.equal(repo.events[0]?.costSource, null);
});

test("BYOK and managed priced events preserve credentialSource and remain distinguishable", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);

  for (const credentialSource of ["byok", "managed"] as const) {
    const model = createMeteredAgentModel(
      scriptedModel(async () => ({
        content: "ok",
        toolCalls: [],
        meta: usageMeta({ inputTokens: 1_000_000, outputTokens: 0 }),
      })),
      {
        attribution: {
          userId: "user-a",
          provider: "openai",
          model: "gpt-test-priced",
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
  assert.equal(repo.events[0]?.costMicros, 2_000_000);
  assert.equal(repo.events[1]?.costMicros, 2_000_000);
  assert.equal(repo.events[0]?.costSource, "test-fixture-v1");
  assert.notEqual(
    repo.events[0]?.credentialSource,
    repo.events[1]?.credentialSource,
  );

  const aggregate = await usage.aggregateCostForUser({
    userId: "user-a",
  });
  assert.equal(aggregate.costMicros, 4_000_000);
  assert.equal(aggregate.byCredentialSource.byok.costMicros, 2_000_000);
  assert.equal(
    aggregate.byCredentialSource.managed.costMicros,
    2_000_000,
  );
});

test("pricing version is persisted; later registry changes do not alter historical cost", async () => {
  const repo = new MemoryModelUsageRepository();
  const v1 = createModelPricingRegistry([FIXTURE_OPENAI]);
  const usageV1 = createModelUsageService(repo, { pricing: v1 });
  await usageV1.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openai",
      model: "gpt-test-priced",
      credentialSource: "managed",
    },
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(repo.events[0]?.costMicros, 2_000_000);
  assert.equal(repo.events[0]?.costSource, "test-fixture-v1");

  const v2Entry: ModelPricingEntry = {
    ...FIXTURE_OPENAI,
    pricingVersion: "test-fixture-v2",
    inputMicrosPerMTok: 9_000_000,
  };
  const usageV2 = createModelUsageService(repo, {
    pricing: createModelPricingRegistry([v2Entry]),
  });
  const listed = await usageV2.listForUser({ userId: "user-a" });
  assert.equal(listed[0]?.costMicros, 2_000_000);
  assert.equal(listed[0]?.costSource, "test-fixture-v1");

  await usageV2.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openai",
      model: "gpt-test-priced",
      credentialSource: "managed",
    },
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(repo.events[1]?.costMicros, 9_000_000);
  assert.equal(repo.events[1]?.costSource, "test-fixture-v2");
});

test("one priced provider call still produces exactly one usage row; raw tokens unchanged", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);
  const model = createMeteredAgentModel(
    scriptedModel(async () => ({
      content: "ok",
      toolCalls: [],
      meta: usageMeta({
        inputTokens: 11,
        outputTokens: 2,
        cachedInputTokens: 4,
        reasoningTokens: 1,
      }),
    })),
    {
      attribution: {
        userId: "user-a",
        provider: "openai",
        model: "gpt-test-priced",
        credentialSource: "managed",
      },
      usage,
    },
  );
  await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.inputTokens, 11);
  assert.equal(repo.events[0]?.outputTokens, 2);
  assert.equal(repo.events[0]?.cachedInputTokens, 4);
  assert.equal(repo.events[0]?.reasoningTokens, 1);
  assert.equal(typeof repo.events[0]?.costMicros, "number");
  assert.ok(Number.isInteger(repo.events[0]?.costMicros));
});

test("OpenRouter unsupported models stay unpriced; exact fixture model is priced", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);

  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      credentialSource: "managed",
    },
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  assert.equal(repo.events[0]?.costMicros, null);

  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openrouter",
      model: "acme/exact-priced-model",
      credentialSource: "byok",
    },
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  });
  assert.equal(repo.events[1]?.costMicros, 3_000_000);
  assert.equal(repo.events[1]?.credentialSource, "byok");
});

test("cost aggregation uses stored snapshots rather than recalculating", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = usageService(repo);
  await usage.record({
    userId: "user-a",
    provider: "openai",
    model: "historical-row",
    credentialSource: "managed",
    tokens: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
    cost: {
      costMicros: 42,
      costCurrency: "USD",
      costSource: "frozen-old-v0",
    },
  });
  await usage.record({
    userId: "user-a",
    provider: "openai",
    model: "unpriced",
    credentialSource: "byok",
    tokens: {
      inputTokens: 99,
      outputTokens: 1,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  });

  const aggregate = await usage.aggregateCostForUser({
    userId: "user-a",
  });
  assert.equal(aggregate.eventCount, 2);
  assert.equal(aggregate.pricedEventCount, 1);
  assert.equal(aggregate.unpricedEventCount, 1);
  assert.equal(aggregate.costMicros, 42);
  assert.equal(aggregate.costCurrency, "USD");
  assert.equal(aggregate.byCredentialSource.managed.costMicros, 42);
  assert.equal(aggregate.byCredentialSource.byok.costMicros, null);

  const managedOnly = await usage.aggregateCostForUser({
    userId: "user-a",
    credentialSource: "managed",
  });
  assert.equal(managedOnly.costMicros, 42);
  assert.equal(managedOnly.eventCount, 1);
});

test("production pricing registry has no invented model prices", () => {
  assert.equal(PRODUCTION_MODEL_PRICING.length, 0);
  assert.equal(
    TEST_PRICING.lookup("openai", "gpt-4.1"),
    null,
  );
  assert.equal(
    TEST_PRICING.lookup("anthropic", "claude-sonnet-4-5"),
    null,
  );
});

// --- Phase B2.1: OpenRouter provider-reported cost ---

test("usdToCostMicros converts exactly and rounds half-up deterministically", async () => {
  const { usdToCostMicros } = await import("../openrouter-models/cost.js");
  assert.equal(usdToCostMicros(0.001234), 1234);
  assert.equal(usdToCostMicros("0.001234"), 1234);
  assert.equal(usdToCostMicros("0.0012345"), 1235);
  assert.equal(usdToCostMicros("0.0012344"), 1234);
  assert.equal(usdToCostMicros(0), 0);
  assert.equal(usdToCostMicros(undefined), null);
  assert.equal(usdToCostMicros(null), null);
  assert.equal(usdToCostMicros(""), null);
  assert.equal(usdToCostMicros(-1), null);
});

test("OpenRouter usage.cost becomes integer micro-USD; missing cost stays null", async () => {
  const { OPENROUTER_USAGE_COST_SOURCE } = await import(
    "../openrouter-models/cost.js"
  );
  const repo = new MemoryModelUsageRepository();
  // Empty production-style registry — provider cost must not need catalog prices.
  const usage = createModelUsageService(repo, {
    pricing: createModelPricingRegistry([]),
  });

  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openrouter",
      model: "openai/gpt-4.1",
      credentialSource: "managed",
    },
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1 },
    providerReportedCostUsd: 0.001234,
  });
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.inputTokens, 10);
  assert.equal(repo.events[0]?.outputTokens, 2);
  assert.equal(repo.events[0]?.cachedInputTokens, 1);
  assert.equal(repo.events[0]?.costMicros, 1234);
  assert.equal(repo.events[0]?.costCurrency, "USD");
  assert.equal(repo.events[0]?.costSource, OPENROUTER_USAGE_COST_SOURCE);
  assert.equal(repo.events[0]?.credentialSource, "managed");

  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openrouter",
      model: "openai/gpt-4.1",
      credentialSource: "byok",
    },
    usage: { inputTokens: 3, outputTokens: 1 },
  });
  assert.equal(repo.events[1]?.credentialSource, "byok");
  assert.equal(repo.events[1]?.costMicros, null);
  assert.equal(repo.events[1]?.costSource, null);
});

test("OpenRouter streaming path records one event with provider cost; catalog unused", async () => {
  const { OPENROUTER_USAGE_COST_SOURCE } = await import(
    "../openrouter-models/cost.js"
  );
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo, {
    pricing: createModelPricingRegistry([]),
  });
  const client: OpenAIChatCompletionsClient = {
    chat: {
      completions: {
        async create(params) {
          assert.equal(params.stream, true);
          async function* chunks() {
            yield { choices: [{ delta: { content: "Hi" } }] };
            yield {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 1,
                cost: "0.0000015",
              },
            };
          }
          return chunks();
        },
      },
    },
  };
  const model = createMeteredAgentModel(
    createOpenRouterAgentModel({ client, model: "openai/gpt-4.1" }),
    {
      attribution: {
        userId: "user-a",
        provider: "openrouter",
        model: "openai/gpt-4.1",
        credentialSource: "managed",
      },
      usage,
    },
  );

  await model.complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onTextDelta: () => undefined,
  });
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0]?.costMicros, 2); // 0.0000015 → half-up to 2 micros
  assert.equal(repo.events[0]?.costSource, OPENROUTER_USAGE_COST_SOURCE);
  assert.equal(repo.events[0]?.inputTokens, 5);
  assert.equal(repo.events[0]?.outputTokens, 1);
});

test("direct OpenAI/Anthropic BYOK does not require a price table", async () => {
  const repo = new MemoryModelUsageRepository();
  const usage = createModelUsageService(repo, {
    pricing: createModelPricingRegistry([]),
  });
  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "openai",
      model: "gpt-user",
      credentialSource: "byok",
    },
    usage: { inputTokens: 9, outputTokens: 4 },
  });
  await usage.recordFromProviderResponse({
    attribution: {
      userId: "user-a",
      provider: "anthropic",
      model: "claude-user",
      credentialSource: "byok",
    },
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  assert.equal(repo.events.length, 2);
  assert.equal(repo.events[0]?.costMicros, null);
  assert.equal(repo.events[1]?.costMicros, null);
  assert.equal(repo.events[0]?.inputTokens, 9);
  assert.equal(repo.events[1]?.inputTokens, 7);
});
