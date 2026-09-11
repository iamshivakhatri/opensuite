import assert from "node:assert/strict";
import { test } from "node:test";

import { createAiModelResolver } from "../ai-preferences/resolver.js";

const managed = {
  provider: "openai" as const,
  anthropicApiKey: null,
  anthropicModel: "claude-test",
  openaiApiKey: "managed-openai-key",
  openaiModel: "managed-model",
  openrouterApiKey: null,
  openrouterModel: null,
};

test("BYOK resolution uses the selected user's credential and never falls back", async () => {
  const users: string[] = [];
  const resolver = createAiModelResolver({
    preferences: { get: async () => ({ provider: "anthropic", model: "claude-user", credentialSource: "byok", createdAt: "", updatedAt: "" }) } as never,
    credentials: { getSecret: async ({ userId }: { userId: string }) => { users.push(userId); return userId === "user-a" ? "user-key" : null; } } as never,
    managed,
  });

  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "anthropic", model: "claude-user", credentialSource: "byok", apiKey: "user-key",
  });
  await assert.rejects(() => resolver.resolve("user-b"), { code: "BYOK_CREDENTIAL_MISSING" });
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

test("no preference preserves the configured managed provider", async () => {
  const resolver = createAiModelResolver({
    preferences: { get: async () => null } as never,
    credentials: null,
    managed,
  });
  assert.deepEqual(await resolver.resolve("user-a"), {
    provider: "openai", model: "managed-model", credentialSource: "managed", apiKey: "managed-openai-key",
  });
});
