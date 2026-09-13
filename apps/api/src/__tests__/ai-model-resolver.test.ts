import assert from "node:assert/strict";
import { test } from "node:test";

import { createAiModelResolver } from "../ai-preferences/resolver.js";
import { createOpenRouterManagedModelCatalog } from "../openrouter-models/catalog.js";

const managed = {
  provider: "openai" as const,
  anthropicApiKey: null,
  anthropicModel: "claude-test",
  openaiApiKey: "managed-openai-key",
  openaiModel: "managed-model",
  openrouterApiKey: "managed-openrouter-key",
  openrouterModel: "openai/gpt-4.1",
};

const catalog = createOpenRouterManagedModelCatalog({
  fetchImpl: async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "openai/gpt-4.1",
            name: "GPT-4.1",
            supported_parameters: ["tools"],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0.000002", completion: "0.000008" },
          },
        ],
      }),
      { status: 200 },
    ),
});

test("BYOK resolution uses the selected user's credential when present", async () => {
  const users: string[] = [];
  const resolver = createAiModelResolver({
    preferences: { get: async () => ({ provider: "anthropic", model: "claude-user", credentialSource: "byok", createdAt: "", updatedAt: "" }) } as never,
    credentials: { getSecret: async ({ userId }: { userId: string }) => { users.push(userId); return userId === "user-a" ? "user-key" : null; } } as never,
    managed,
  });

  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "anthropic", model: "claude-user", credentialSource: "byok", apiKey: "user-key",
  });
  // Missing key falls back to managed trial (OpenRouter gateway).
  assert.deepEqual(await resolver.resolve("user-b"), {
    provider: "openrouter",
    model: "openai/gpt-4.1",
    credentialSource: "managed",
    apiKey: "managed-openrouter-key",
  });
  assert.deepEqual(users, ["user-a", "user-b"]);
});

test("managed resolution does not read a user's BYOK credential", async () => {
  let readCredential = false;
  const resolver = createAiModelResolver({
    preferences: { get: async () => ({ provider: "openai", model: "chosen-model", credentialSource: "managed", createdAt: "", updatedAt: "" }) } as never,
    credentials: { getSecret: async () => { readCredential = true; return "user-key"; } } as never,
    managed,
  });

  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "openai", model: "chosen-model", credentialSource: "managed", apiKey: "managed-openai-key",
  });
  assert.equal(readCredential, false);
});

test("no preference uses OpenRouter managed gateway when configured", async () => {
  const resolver = createAiModelResolver({
    preferences: { get: async () => null } as never,
    credentials: null,
    managed,
  });
  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "openrouter",
    model: "openai/gpt-4.1",
    credentialSource: "managed",
    apiKey: "managed-openrouter-key",
  });
});

test("managed OpenRouter preference uses server OPENROUTER_MODEL, not the saved id", async () => {
  const resolver = createAiModelResolver({
    preferences: {
      get: async () => ({
        provider: "openrouter",
        model: "openai/stale-saved-model",
        credentialSource: "managed",
        createdAt: "",
        updatedAt: "",
      }),
    } as never,
    credentials: {
      getSecret: async () => {
        throw new Error("must not read BYOK");
      },
    } as never,
    managed,
    catalog,
  });

  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "openrouter",
    model: "openai/gpt-4.1",
    credentialSource: "managed",
    apiKey: "managed-openrouter-key",
  });
});

test("managed OpenRouter unavailable server model fails without silent fallback", async () => {
  const resolver = createAiModelResolver({
    preferences: {
      get: async () => ({
        provider: "openrouter",
        model: "openai/gpt-4.1",
        credentialSource: "managed",
        createdAt: "",
        updatedAt: "",
      }),
    } as never,
    credentials: null,
    managed: { ...managed, openrouterModel: "openai/retired-model" },
    catalog,
  });

  await assert.rejects(() => resolver.resolve("user-a"), {
    code: "MODEL_UNAVAILABLE",
  });
});
