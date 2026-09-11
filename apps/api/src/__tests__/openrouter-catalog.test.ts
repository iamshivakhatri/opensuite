import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOpenRouterManagedModelCatalog,
  DEFAULT_CATALOG_TTL_MS,
  normalizeManagedAiModel,
  normalizeManagedAiModels,
} from "../openrouter-models/catalog.js";
import { OpenRouterCatalogError } from "../openrouter-models/types.js";

const TOOL_TEXT_MODEL = {
  id: "openai/gpt-4.1",
  name: "GPT-4.1",
  context_length: 128000,
  supported_parameters: ["tools", "temperature"],
  architecture: { output_modalities: ["text"] },
  pricing: {
    prompt: "0.000002",
    completion: "0.000008",
    input_cache_read: "0.0000005",
  },
};

const NO_TOOLS_MODEL = {
  id: "acme/no-tools",
  name: "No Tools",
  context_length: 8000,
  supported_parameters: ["temperature"],
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
};

const IMAGE_ONLY_MODEL = {
  id: "acme/image-only",
  name: "Image Only",
  supported_parameters: ["tools"],
  architecture: { output_modalities: ["image"] },
  pricing: { prompt: "0", completion: "0" },
};

test("normalize preserves exact OpenRouter ids and live pricing strings", () => {
  const model = normalizeManagedAiModel(TOOL_TEXT_MODEL);
  assert.ok(model);
  assert.equal(model!.id, "openai/gpt-4.1");
  assert.equal(model!.name, "GPT-4.1");
  assert.equal(model!.contextLength, 128000);
  assert.deepEqual(model!.supportedParameters, ["tools", "temperature"]);
  assert.equal(model!.pricing.prompt, "0.000002");
  assert.equal(model!.pricing.completion, "0.000008");
  assert.equal(model!.pricing.inputCacheRead, "0.0000005");
  assert.equal(model!.author, "openai");
  assert.equal(typeof model!.pricing.prompt, "string");
});

test("incompatible models are excluded; tool+text models are included", () => {
  const models = normalizeManagedAiModels({
    data: [TOOL_TEXT_MODEL, NO_TOOLS_MODEL, IMAGE_ONLY_MODEL, { name: "missing-id" }],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "openai/gpt-4.1");
});

test("catalog fetches once inside TTL and refreshes after expiry", async () => {
  let calls = 0;
  let now = 1_000_000;
  const catalog = createOpenRouterManagedModelCatalog({
    ttlMs: 1_000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              ...TOOL_TEXT_MODEL,
              id: calls === 1 ? "openai/gpt-4.1" : "anthropic/claude-sonnet-4",
              name: calls === 1 ? "GPT-4.1" : "Claude Sonnet 4",
              supported_parameters: ["tools"],
              architecture: { output_modalities: ["text"] },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const first = await catalog.listManagedModels();
  const second = await catalog.listManagedModels();
  assert.equal(calls, 1);
  assert.equal(first[0]?.id, "openai/gpt-4.1");
  assert.equal(second[0]?.id, "openai/gpt-4.1");

  now += 1_001;
  const third = await catalog.listManagedModels();
  assert.equal(calls, 2);
  assert.equal(third[0]?.id, "anthropic/claude-sonnet-4");
  assert.equal(DEFAULT_CATALOG_TTL_MS, 10 * 60 * 1000);
});

test("stale cache survives temporary refresh failure; initial failure is clear", async () => {
  let calls = 0;
  let now = 0;
  const catalog = createOpenRouterManagedModelCatalog({
    ttlMs: 10,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ data: [TOOL_TEXT_MODEL] }), {
          status: 200,
        });
      }
      return new Response("upstream down", { status: 503 });
    },
  });

  const fresh = await catalog.listManagedModels();
  assert.equal(fresh[0]?.id, "openai/gpt-4.1");

  now += 100;
  const stale = await catalog.listManagedModels();
  assert.equal(stale[0]?.id, "openai/gpt-4.1");
  assert.equal(calls, 2);

  const empty = createOpenRouterManagedModelCatalog({
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  await assert.rejects(
    () => empty.listManagedModels(),
    (error: unknown) =>
      error instanceof OpenRouterCatalogError &&
      error.code === "CATALOG_UNAVAILABLE",
  );
});

test("catalog responses never include Authorization or API keys", async () => {
  const secret = "sk-or-v1-super-secret";
  let sawAuth = false;
  const catalog = createOpenRouterManagedModelCatalog({
    apiKey: secret,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawAuth = headers.get("Authorization") === `Bearer ${secret}`;
      return new Response(JSON.stringify({ data: [TOOL_TEXT_MODEL] }), {
        status: 200,
      });
    },
  });

  const models = await catalog.listManagedModels();
  assert.equal(sawAuth, true);
  const serialized = JSON.stringify(models);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("Bearer"), false);
});

test("requireManagedModel rejects unknown ids without silent fallback", async () => {
  const catalog = createOpenRouterManagedModelCatalog({
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [TOOL_TEXT_MODEL] }), { status: 200 }),
  });
  await assert.rejects(
    () => catalog.requireManagedModel("openai/does-not-exist"),
    (error: unknown) =>
      error instanceof OpenRouterCatalogError && error.code === "MODEL_UNAVAILABLE",
  );
  const found = await catalog.requireManagedModel("openai/gpt-4.1");
  assert.equal(found.id, "openai/gpt-4.1");
});
