import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import type { AppDependencies } from "../app.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import {
  createUserRateLimiter,
  type UserRateLimitPolicy,
} from "../user-rate-limit.js";
import { multipartFilePayload, testS3Env } from "./support/test-env.js";

function testConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/opensuite",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3001",
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    AGENT_MODEL_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "openai/gpt-4.1",
    ...testS3Env,
    ...overrides,
  });
}

/**
 * Mock auth used by unit tests: `handler` mirrors the shape of the real
 * Better Auth `/api/auth/*` responses, and `sessionUser` controls what
 * `api.getSession` resolves to (simulating an authenticated/unauthenticated
 * caller) without touching a real database.
 */
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

/** Unit-test placeholder — supports health SELECT 1 probe. */
function stubDb(): Db {
  return {
    execute: async () => ({ rows: [{ ok: 1 }] }),
  } as unknown as Db;
}

async function testApp(sessionUser: AuthenticatedUser | null = null) {
  return buildApp(testConfig(), {
    auth: mockAuth(sessionUser),
    db: stubDb(),
    storage: createMemoryObjectStorage(),
  });
}

test("GET /health returns 200 with a status payload", async () => {
  const app = await testApp();

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.database, "ok");
  assert.equal(typeof body.uptimeSeconds, "number");

  await app.close();
});

test("GET / returns plain OpenSuite API text", async () => {
  const app = await testApp();

  const response = await app.inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  assert.equal(response.body, "OpenSuite API\n");

  await app.close();
});

test("API sends fixed security headers and only allows the web origin", async () => {
  const app = await testApp();

  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");

  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/api/me",
    headers: {
      origin: "http://localhost:3001",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:3001");

  const denied = await app.inject({
    method: "OPTIONS",
    url: "/api/me",
    headers: {
      origin: "https://not-opensuite.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);

  await app.close();
});

test("authenticated write limits return 429 with Retry-After", async () => {
  const policy: UserRateLimitPolicy = {
    agentRun: [{ limit: 1, windowMs: 60_000 }],
    documentWrite: [{ limit: 1, windowMs: 60_000 }],
    workspaceCreate: [{ limit: 1, windowMs: 60_000 }],
  };
  const limiter = createUserRateLimiter(policy);
  const user = { id: "user-1", name: "Ada", email: "ada@example.com" };
  limiter.consume(user.id, "agentRun");
  limiter.consume(user.id, "documentWrite");
  limiter.consume(user.id, "workspaceCreate");
  const app = await buildApp(testConfig(), {
    auth: mockAuth(user),
    db: stubDb(),
    storage: createMemoryObjectStorage(),
    rateLimiter: limiter,
  });

  const workspace = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "Limited" },
  });
  assert.equal(workspace.statusCode, 429);
  assert.ok(workspace.headers["retry-after"]);

  const upload = await app.inject({
    method: "POST",
    url: `/api/workspaces/${randomUUID()}/documents`,
    ...multipartFilePayload("limited.docx", "test"),
  });
  assert.equal(upload.statusCode, 429);
  assert.ok(upload.headers["retry-after"]);

  const run = await app.inject({
    method: "POST",
    url: `/api/agent/threads/${randomUUID()}/runs`,
    payload: { instruction: "Summarize this document" },
  });
  assert.equal(run.statusCode, 429);
  assert.ok(run.headers["retry-after"]);

  await app.close();
});

test("GET /health reports degraded when database probe fails", async () => {
  const app = await buildApp(testConfig(), {
    auth: mockAuth(),
    db: {
      execute: async () => {
        throw Object.assign(new Error("connect ETIMEDOUT"), {
          code: "ETIMEDOUT",
        });
      },
    } as unknown as Db,
    storage: createMemoryObjectStorage(),
  });

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.database, "unavailable");

  await app.close();
});

test("protected routes map Postgres outages to DATABASE_UNAVAILABLE", async () => {
  const app = await buildApp(testConfig(), {
    auth: {
      handler: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      api: {
        getSession: async () => {
          throw Object.assign(new Error("connect ETIMEDOUT"), {
            code: "ETIMEDOUT",
          });
        },
      },
    },
    db: stubDb(),
    storage: createMemoryObjectStorage(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/me",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: {
      statusCode: 503,
      message: "No connection with the database",
      code: "DATABASE_UNAVAILABLE",
    },
  });

  await app.close();
});

test("auth get-session 5xx becomes DATABASE_UNAVAILABLE when DB is down", async () => {
  const app = await buildApp(testConfig(), {
    auth: {
      handler: async () =>
        new Response(JSON.stringify({ message: "Failed to get session" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      api: {
        getSession: async () => null,
      },
    },
    db: {
      execute: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    } as unknown as Db,
    storage: createMemoryObjectStorage(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/auth/get-session",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DATABASE_UNAVAILABLE");

  await app.close();
});

test("GET /api/auth/get-session forwards to the Better Auth handler", async () => {
  const app = await testApp();

  const response = await app.inject({
    method: "GET",
    url: "/api/auth/get-session",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });

  await app.close();
});

test("auth handler receives the configured public HTTPS URL behind a proxy", async () => {
  let requestUrl: string | undefined;
  const app = await buildApp(
    testConfig({ BETTER_AUTH_URL: "https://api.opensuite.test" }),
    {
      auth: {
        handler: async (request) => {
          requestUrl = request.url;
          return new Response("null", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        api: { getSession: async () => null },
      },
      db: stubDb(),
      storage: createMemoryObjectStorage(),
    },
  );

  const response = await app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: { host: "api-internal:3000" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requestUrl, "https://api.opensuite.test/api/auth/get-session");
  await app.close();
});

test("auth callback preserves its session cookie and app destination", async () => {
  const app = await buildApp(testConfig(), {
    auth: {
      handler: async () => {
        const headers = new Headers({ Location: "https://www.opensuite.test/app" });
        headers.append(
          "Set-Cookie",
          "__Secure-better-auth.session_token=session-token; Path=/; HttpOnly; Secure; SameSite=Lax",
        );
        headers.append(
          "Set-Cookie",
          "__Secure-better-auth.state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
        );
        return new Response(null, { status: 302, headers });
      },
      api: { getSession: async () => null },
    },
    db: stubDb(),
    storage: createMemoryObjectStorage(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/auth/callback/google?state=test&code=test",
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "https://www.opensuite.test/app");
  const cookies = response.headers["set-cookie"];
  assert.ok(cookies);
  assert.match(Array.isArray(cookies) ? cookies.join("\n") : cookies, /session_token=/);
  await app.close();
});

test("GET /api/me returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({ method: "GET", url: "/api/me" });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error.code, "UNAUTHENTICATED");

  await app.close();
});

test("GET /api/me returns only id/name/email when authenticated", async () => {
  const app = await testApp({
    id: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
  });

  const response = await app.inject({ method: "GET", url: "/api/me" });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body, {
    user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
  });

  await app.close();
});

test("GET /api/workspaces returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({ method: "GET", url: "/api/workspaces" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("POST /api/workspaces returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { "content-type": "application/json" },
    payload: { name: "My Workspace" },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("POST /api/workspaces rejects an empty/whitespace workspace name", async () => {
  const app = await testApp({
    id: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
  });

  for (const payload of [{ name: "" }, { name: "   " }, {}, { name: 12 }]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": "application/json" },
      payload,
    });

    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "INVALID_WORKSPACE_NAME");
  }

  await app.close();
});

test("POST /api/workspaces/:workspaceId/documents returns 401 when there is no session", async () => {
  const app = await testApp(null);
  const file = multipartFilePayload("notes.docx", "PK");

  const response = await app.inject({
    method: "POST",
    url: `/api/workspaces/${randomUUID()}/documents`,
    headers: file.headers,
    payload: file.payload,
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("GET /api/workspaces/:workspaceId/documents returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({
    method: "GET",
    url: `/api/workspaces/${randomUUID()}/documents`,
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("GET /api/documents/:documentId/download returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({
    method: "GET",
    url: `/api/documents/${randomUUID()}/download`,
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("GET /api/documents/:documentId returns 401 when there is no session", async () => {
  const app = await testApp(null);

  const response = await app.inject({
    method: "GET",
    url: `/api/documents/${randomUUID()}`,
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");

  await app.close();
});

test("an unknown route returns 404", async () => {
  const app = await testApp();

  const response = await app.inject({ method: "GET", url: "/unknown-route" });

  assert.equal(response.statusCode, 404);

  await app.close();
});
test("an unhandled route error is converted to a structured 500 response", async () => {
  const app = await testApp();
  app.get("/__boom", async () => {
    throw new Error("boom");
  });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/__boom" });

  assert.equal(response.statusCode, 500);
  const body = response.json();
  assert.equal(body.error.statusCode, 500);
  assert.equal(body.error.message, "Internal Server Error");

  await app.close();
});
