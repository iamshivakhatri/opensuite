import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient } from "@opensuite/db";

import { createAuth } from "../auth/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

test(
  "email/password sign-up and session retrieval work through /api/auth/*",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ??
        "test-secret-that-is-at-least-32-characters-long",
      BETTER_AUTH_URL: "http://localhost:3000",
      WEB_ORIGIN: "http://localhost:3001",
    });

    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const auth = createAuth(config, dbClient.db);
    const app = await buildApp(config, { auth });
    await app.ready();

    const email = `auth-test-${randomUUID()}@example.com`;
    const password = "password1234";

    try {
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: {
          name: "Auth Test User",
          email,
          password,
        },
      });

      assert.equal(signUp.statusCode, 200, signUp.body);

      const setCookie = signUp.headers["set-cookie"];
      assert.ok(setCookie, "expected session cookie after sign-up");

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/get-session",
        headers: {
          cookie: Array.isArray(setCookie) ? setCookie.join("; ") : setCookie,
          origin: config.webOrigin,
        },
      });

      assert.equal(session.statusCode, 200, session.body);
      const body = session.json() as {
        user?: { email?: string };
        session?: { id?: string };
      };
      assert.equal(body.user?.email, email);
      assert.ok(body.session?.id);

      const cookieHeader = Array.isArray(setCookie)
        ? setCookie.join("; ")
        : setCookie;

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: {
          cookie: cookieHeader,
          origin: config.webOrigin,
        },
      });

      assert.equal(me.statusCode, 200, me.body);
      const meBody = me.json() as {
        user?: { id?: string; name?: string; email?: string };
      };
      assert.equal(meBody.user?.email, email);
      assert.equal(meBody.user?.name, "Auth Test User");
      assert.ok(meBody.user?.id);
      assert.deepEqual(Object.keys(meBody).sort(), ["user"]);
      assert.deepEqual(
        Object.keys(meBody.user ?? {}).sort(),
        ["email", "id", "name"],
      );

      const meWithoutSession = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { origin: config.webOrigin },
      });

      assert.equal(meWithoutSession.statusCode, 401, meWithoutSession.body);

      const meWithInvalidCookie = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: {
          cookie: "better-auth.session_token=not-a-real-session-token",
          origin: config.webOrigin,
        },
      });

      assert.equal(meWithInvalidCookie.statusCode, 401, meWithInvalidCookie.body);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
