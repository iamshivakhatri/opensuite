import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import type { AppDependencies } from "../app.js";
import { buildApp } from "../app.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { loadConfig } from "../config/index.js";
import { createCredentialCipher } from "../credentials/crypto.js";
import type {
  ProviderCredentialRepository,
  StoredProviderCredential,
} from "../credentials/repository.js";
import { createProviderCredentialService } from "../credentials/service.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import { testS3Env } from "./support/test-env.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const secretApiKey = "sk-test-secret-key-do-not-leak";

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

function stubDb(): Db {
  return {} as Db;
}

class MemoryCredentialRepository implements ProviderCredentialRepository {
  readonly records = new Map<string, StoredProviderCredential>();

  private recordKey(userId: string, provider: string) {
    return `${userId}:${provider}`;
  }

  async save(
    input: Omit<StoredProviderCredential, "id" | "createdAt" | "updatedAt">,
  ): Promise<StoredProviderCredential> {
    const recordKey = this.recordKey(input.userId, input.provider);
    const existing = this.records.get(recordKey);
    const now = new Date();
    const saved: StoredProviderCredential = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(recordKey, saved);
    return saved;
  }

  async get(userId: string, provider: "anthropic" | "openai" | "openrouter") {
    return this.records.get(this.recordKey(userId, provider)) ?? null;
  }

  async listByUser(userId: string) {
    return [...this.records.values()].filter(
      (record) => record.userId === userId,
    );
  }

  async delete(
    userId: string,
    provider: "anthropic" | "openai" | "openrouter",
  ) {
    return this.records.delete(this.recordKey(userId, provider));
  }
}

function assertNoSecretLeak(bodyText: string) {
  assert.equal(bodyText.includes(secretApiKey), false);
  assert.equal(bodyText.includes("encryptedPayload"), false);
  assert.equal(bodyText.includes("ciphertext"), false);
  assert.equal(bodyText.includes("nonce"), false);
  assert.equal(bodyText.includes("authTag"), false);
  assert.equal(bodyText.includes("encryptionVersion"), false);
}

function assertSafeCredentialShape(credential: Record<string, unknown>) {
  assert.deepEqual(Object.keys(credential).sort(), [
    "connected",
    "createdAt",
    "provider",
    "updatedAt",
  ]);
  assert.equal(credential.connected, true);
  assert.equal(typeof credential.provider, "string");
  assert.equal(typeof credential.createdAt, "string");
  assert.equal(typeof credential.updatedAt, "string");
}

async function testApp(options: {
  sessionUser?: AuthenticatedUser | null;
  repository?: MemoryCredentialRepository;
}) {
  const repository = options.repository ?? new MemoryCredentialRepository();
  const credentials = createProviderCredentialService(
    repository,
    createCredentialCipher(encryptionKey),
  );
  const app = await buildApp(testConfig(), {
    auth: mockAuth(options.sessionUser ?? null),
    db: stubDb(),
    storage: createMemoryObjectStorage(),
    credentials,
  });
  return { app, repository, credentials };
}

const alice: AuthenticatedUser = {
  id: "user-alice",
  name: "Alice",
  email: "alice@example.com",
};

const bob: AuthenticatedUser = {
  id: "user-bob",
  name: "Bob",
  email: "bob@example.com",
};

test("unauthenticated provider credential list/connect/delete are rejected", async () => {
  const { app } = await testApp({ sessionUser: null });

  const list = await app.inject({
    method: "GET",
    url: "/api/provider-credentials",
  });
  assert.equal(list.statusCode, 401);
  assert.equal(list.json().error.code, "UNAUTHENTICATED");

  const connect = await app.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: secretApiKey },
  });
  assert.equal(connect.statusCode, 401);
  assert.equal(connect.json().error.code, "UNAUTHENTICATED");
  assertNoSecretLeak(connect.body);

  const remove = await app.inject({
    method: "DELETE",
    url: "/api/provider-credentials/openai",
  });
  assert.equal(remove.statusCode, 401);
  assert.equal(remove.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("authenticated user can connect a supported provider with safe metadata only", async () => {
  const { app, repository } = await testApp({ sessionUser: alice });

  const connect = await app.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: `  ${secretApiKey}  ` },
  });

  assert.equal(connect.statusCode, 200, connect.body);
  const body = connect.json() as {
    credential: Record<string, unknown>;
  };
  assertSafeCredentialShape(body.credential);
  assert.equal(body.credential.provider, "openai");
  assertNoSecretLeak(connect.body);
  assert.equal(repository.records.size, 1);
  const stored = [...repository.records.values()][0]!;
  assert.equal(JSON.stringify(stored).includes(secretApiKey), false);

  await app.close();
});

test("listing shows the authenticated user's connected providers only", async () => {
  const repository = new MemoryCredentialRepository();
  const { app: aliceApp } = await testApp({
    sessionUser: alice,
    repository,
  });

  await aliceApp.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: secretApiKey },
  });
  await aliceApp.close();

  const { app: bobApp } = await testApp({
    sessionUser: bob,
    repository,
  });
  await bobApp.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "anthropic", apiKey: "sk-bob-secret" },
  });
  await bobApp.close();

  const { app: aliceListApp } = await testApp({
    sessionUser: alice,
    repository,
  });
  const list = await aliceListApp.inject({
    method: "GET",
    url: "/api/provider-credentials",
  });
  assert.equal(list.statusCode, 200, list.body);
  const body = list.json() as {
    credentials: Array<Record<string, unknown>>;
  };
  assert.equal(body.credentials.length, 1);
  assertSafeCredentialShape(body.credentials[0]!);
  assert.equal(body.credentials[0]!.provider, "openai");
  assertNoSecretLeak(list.body);
  assert.equal(list.body.includes("sk-bob-secret"), false);

  await aliceListApp.close();
});

test("reconnecting the same provider upserts instead of creating duplicates", async () => {
  const repository = new MemoryCredentialRepository();
  const { app, credentials } = await testApp({
    sessionUser: alice,
    repository,
  });

  const first = await app.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: "sk-old" },
  });
  const second = await app.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: secretApiKey },
  });

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(repository.records.size, 1);
  assert.equal(
    await credentials.getSecret({ userId: alice.id, provider: "openai" }),
    secretApiKey,
  );
  assertNoSecretLeak(second.body);

  await app.close();
});

test("removing a credential is owner-scoped and works for the owner", async () => {
  const repository = new MemoryCredentialRepository();
  const { app: aliceApp } = await testApp({
    sessionUser: alice,
    repository,
  });
  await aliceApp.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "openai", apiKey: secretApiKey },
  });
  await aliceApp.close();

  const { app: bobApp } = await testApp({
    sessionUser: bob,
    repository,
  });
  const bobDelete = await bobApp.inject({
    method: "DELETE",
    url: "/api/provider-credentials/openai",
  });
  assert.equal(bobDelete.statusCode, 404);
  assert.equal(bobDelete.json().error.code, "CREDENTIAL_NOT_FOUND");
  assert.equal(repository.records.size, 1);
  await bobApp.close();

  const { app: aliceDeleteApp } = await testApp({
    sessionUser: alice,
    repository,
  });
  const aliceDelete = await aliceDeleteApp.inject({
    method: "DELETE",
    url: "/api/provider-credentials/openai",
  });
  assert.equal(aliceDelete.statusCode, 204, aliceDelete.body);
  assert.equal(repository.records.size, 0);

  const list = await aliceDeleteApp.inject({
    method: "GET",
    url: "/api/provider-credentials",
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { credentials: [] });

  await aliceDeleteApp.close();
});

test("unsupported provider and empty API key input are rejected", async () => {
  const { app } = await testApp({ sessionUser: alice });

  const unsupported = await app.inject({
    method: "PUT",
    url: "/api/provider-credentials",
    headers: { "content-type": "application/json" },
    payload: { provider: "azure", apiKey: secretApiKey },
  });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.json().error.code, "UNSUPPORTED_PROVIDER");
  assertNoSecretLeak(unsupported.body);

  const unsupportedDelete = await app.inject({
    method: "DELETE",
    url: "/api/provider-credentials/azure",
  });
  assert.equal(unsupportedDelete.statusCode, 400);
  assert.equal(unsupportedDelete.json().error.code, "UNSUPPORTED_PROVIDER");

  for (const payload of [
    { provider: "openai", apiKey: "" },
    { provider: "openai", apiKey: "   " },
    { provider: "openai" },
    { provider: "openai", apiKey: 12 },
  ]) {
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/provider-credentials",
      headers: { "content-type": "application/json" },
      payload,
    });
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
    assert.equal(invalid.json().error.code, "INVALID_API_KEY");
    assertNoSecretLeak(invalid.body);
  }

  await app.close();
});
