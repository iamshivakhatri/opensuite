import assert from "node:assert/strict";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import type { AppDependencies } from "../app.js";
import { buildApp } from "../app.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { loadConfig } from "../config/index.js";
import { createOpenRouterManagedModelCatalog } from "../openrouter-models/catalog.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import { testS3Env } from "./support/test-env.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");

const TOOL_MODEL = {
  id: "openai/gpt-4.1",
  name: "GPT-4.1",
  context_length: 128000,
  supported_parameters: ["tools"],
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "0.000002", completion: "0.000008" },
};

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/opensuite",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3001",
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    AI_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    AGENT_MODEL_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test-managed",
    OPENROUTER_MODEL: "openai/gpt-4.1",
    ...testS3Env,
  });
}

function mockAuth(
  sessionUser: AuthenticatedUser | null = null,
): AppDependencies["auth"] {
  return {
    handler: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    api: {
      getSession: async () =>
        sessionUser
          ? { user: sessionUser, session: { id: "mock-session" } }
          : null,
    },
  };
}

function stubDb(preferenceStore: {
  row: {
    userId: string;
    provider: "anthropic" | "openai" | "openrouter";
    model: string;
    credentialSource: "byok" | "managed";
    createdAt: Date;
    updatedAt: Date;
  } | null;
}): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (preferenceStore.row ? [preferenceStore.row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: {
        userId: string;
        provider: "anthropic" | "openai" | "openrouter";
        model: string;
        credentialSource: "byok" | "managed";
        updatedAt: Date;
      }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const now = values.updatedAt;
            preferenceStore.row = {
              userId: values.userId,
              provider: values.provider,
              model: values.model,
              credentialSource: values.credentialSource,
              createdAt: preferenceStore.row?.createdAt ?? now,
              updatedAt: now,
            };
            return [preferenceStore.row];
          },
        }),
      }),
    }),
  } as unknown as Db;
}

async function buildTestApp(input?: {
  sessionUser?: AuthenticatedUser | null;
  fetchImpl?: typeof fetch;
}) {
  const preferenceStore = { row: null as null | {
    userId: string;
    provider: "anthropic" | "openai" | "openrouter";
    model: string;
    credentialSource: "byok" | "managed";
    createdAt: Date;
    updatedAt: Date;
  } };
  const catalog = createOpenRouterManagedModelCatalog({
    apiKey: "sk-or-test-managed",
    fetchImpl:
      input?.fetchImpl ??
      (async () =>
        new Response(JSON.stringify({ data: [TOOL_MODEL] }), { status: 200 })),
  });
  const app = await buildApp(testConfig(), {
    auth: mockAuth(
      input?.sessionUser === undefined
        ? { id: "user-a", name: "Ada", email: "ada@example.com" }
        : input.sessionUser,
    ),
    db: stubDb(preferenceStore),
    storage: createMemoryObjectStorage(),
    managedModelCatalog: catalog,
    createBlankDocxBytes: () => new Uint8Array([1, 2, 3]),
  });
  return { app, preferenceStore, catalog };
}

test("GET /api/ai-models/managed returns normalized models without secrets", async () => {
  const { app } = await buildTestApp();
  const response = await app.inject({
    method: "GET",
    url: "/api/ai-models/managed",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    models: Array<{ id: string; pricing: { prompt?: string } }>;
  };
  assert.equal(body.models.length, 1);
  assert.equal(body.models[0]?.id, "openai/gpt-4.1");
  assert.equal(body.models[0]?.pricing.prompt, "0.000002");
  assert.equal(JSON.stringify(body).includes("sk-or"), false);
  assert.equal(JSON.stringify(body).includes("Authorization"), false);
  await app.close();
});

test("GET /api/ai-models/managed requires auth and maps upstream failure", async () => {
  const unauth = await buildTestApp({ sessionUser: null });
  const denied = await unauth.app.inject({
    method: "GET",
    url: "/api/ai-models/managed",
  });
  assert.equal(denied.statusCode, 401);
  await unauth.app.close();

  const failing = await buildTestApp({
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  const unavailable = await failing.app.inject({
    method: "GET",
    url: "/api/ai-models/managed",
  });
  assert.equal(unavailable.statusCode, 502);
  assert.equal(unavailable.json().error.code, "CATALOG_UNAVAILABLE");
  await failing.app.close();
});

test("managed preference saves server OPENROUTER_MODEL and ignores client model id", async () => {
  const { app, preferenceStore } = await buildTestApp();

  const ok = await app.inject({
    method: "PUT",
    url: "/api/ai-preferences",
    payload: {
      credentialSource: "managed",
      provider: "openrouter",
      model: "openai/client-picked-ignored",
    },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().preference.provider, "openrouter");
  assert.equal(ok.json().preference.model, "openai/gpt-4.1");
  assert.equal(ok.json().preference.credentialSource, "managed");
  assert.equal(preferenceStore.row?.model, "openai/gpt-4.1");

  const bare = await app.inject({
    method: "PUT",
    url: "/api/ai-preferences",
    payload: { credentialSource: "managed" },
  });
  assert.equal(bare.statusCode, 200);
  assert.equal(bare.json().preference.model, "openai/gpt-4.1");
  await app.close();
});

test("BYOK preferences remain unconstrained by managed catalog", async () => {
  const { app, preferenceStore } = await buildTestApp();
  const response = await app.inject({
    method: "PUT",
    url: "/api/ai-preferences",
    payload: {
      provider: "openai",
      model: "gpt-user-custom",
      credentialSource: "byok",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().preference.provider, "openai");
  assert.equal(response.json().preference.model, "gpt-user-custom");
  assert.equal(response.json().preference.credentialSource, "byok");
  assert.equal(preferenceStore.row?.provider, "openai");
  await app.close();
});

test("managed preference rejects non-openrouter provider hints", async () => {
  const { app, preferenceStore } = await buildTestApp();
  const response = await app.inject({
    method: "PUT",
    url: "/api/ai-preferences",
    payload: {
      provider: "openai",
      model: "gpt-4.1",
      credentialSource: "managed",
    },
  });
  // Managed always uses OpenRouter + server model; client provider is ignored.
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().preference.provider, "openrouter");
  assert.equal(response.json().preference.model, "openai/gpt-4.1");
  assert.equal(preferenceStore.row?.provider, "openrouter");
  await app.close();
});

test("BYOK preference requires provider and model", async () => {
  const { app } = await buildTestApp();
  const response = await app.inject({
    method: "PUT",
    url: "/api/ai-preferences",
    payload: {
      credentialSource: "byok",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_AI_PREFERENCE");
  await app.close();
});
