import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import type { AppDependencies } from "../app.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import { multipartFilePayload, testS3Env } from "./support/test-env.js";

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
    ...testS3Env,
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

/** Unit-test placeholder — never queried by the cases below. */
function stubDb(): Db {
  return {} as Db;
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
  assert.equal(typeof body.uptimeSeconds, "number");

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
