import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient } from "@opensuite/db";

import { createAuth } from "../auth/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import {
  createStubEmailSender,
  extractEmailActionUrl,
} from "./support/stub-email-sender.js";
import { testS3Env } from "./support/test-env.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ??
      "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3001",
    RESEND_API_KEY: "re_test_key_unused_stub_sender_is_injected_instead",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    ...testS3Env,
  });
}

async function signUpVerifyAndSignIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  emailSender: ReturnType<typeof createStubEmailSender>,
  name: string,
): Promise<{ cookie: string; userId: string }> {
  const email = `ws-${name}-${randomUUID()}@example.com`;
  const password = "password1234";

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: {
      "content-type": "application/json",
      origin: config.webOrigin,
    },
    payload: {
      name,
      email,
      password,
      callbackURL: `${config.webOrigin}/sign-in?verified=true`,
    },
  });
  assert.equal(signUp.statusCode, 200, signUp.body);

  const verificationUrl = extractEmailActionUrl(
    emailSender.sent[emailSender.sent.length - 1]!,
  );
  const verifyUrl = new URL(verificationUrl);
  const verify = await app.inject({
    method: "GET",
    url: `${verifyUrl.pathname}${verifyUrl.search}`,
    headers: { origin: config.webOrigin },
  });
  assert.equal(verify.statusCode, 302, verify.body);

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: {
      "content-type": "application/json",
      origin: config.webOrigin,
    },
    payload: { email, password },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const setCookie = signIn.headers["set-cookie"];
  assert.ok(setCookie, "expected session cookie");
  const cookie = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;

  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie, origin: config.webOrigin },
  });
  assert.equal(me.statusCode, 200, me.body);
  const userId = (me.json() as { user: { id: string } }).user.id;
  assert.ok(userId);

  return { cookie, userId };
}

test(
  "authenticated workspace create/list is owner-scoped",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage: createMemoryObjectStorage(),
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "Alice",
      );
      const bob = await signUpVerifyAndSignIn(app, config, emailSender, "Bob");

      const createAlice = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { name: "  Alice Workspace  " },
      });
      assert.equal(createAlice.statusCode, 201, createAlice.body);
      const aliceWorkspace = (
        createAlice.json() as {
          workspace: {
            id: string;
            name: string;
            createdAt: string;
            updatedAt: string;
          };
        }
      ).workspace;
      assert.equal(aliceWorkspace.name, "Alice Workspace");
      assert.ok(aliceWorkspace.id);
      assert.ok(aliceWorkspace.createdAt);
      assert.ok(aliceWorkspace.updatedAt);
      assert.equal(
        "ownerUserId" in aliceWorkspace,
        false,
        "response should not expose raw owner column",
      );

      const createBob = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: {
          "content-type": "application/json",
          cookie: bob.cookie,
          origin: config.webOrigin,
        },
        payload: { name: "Bob Workspace" },
      });
      assert.equal(createBob.statusCode, 201, createBob.body);
      const bobWorkspace = (
        createBob.json() as { workspace: { id: string; name: string } }
      ).workspace;
      assert.equal(bobWorkspace.name, "Bob Workspace");

      const aliceList = await app.inject({
        method: "GET",
        url: "/api/workspaces",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(aliceList.statusCode, 200, aliceList.body);
      const aliceWorkspaces = (
        aliceList.json() as { workspaces: Array<{ id: string; name: string }> }
      ).workspaces;
      assert.equal(aliceWorkspaces.length, 1);
      assert.equal(aliceWorkspaces[0]?.id, aliceWorkspace.id);
      assert.equal(
        aliceWorkspaces.some((w) => w.id === bobWorkspace.id),
        false,
      );

      const bobList = await app.inject({
        method: "GET",
        url: "/api/workspaces",
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(bobList.statusCode, 200, bobList.body);
      const bobWorkspaces = (
        bobList.json() as { workspaces: Array<{ id: string; name: string }> }
      ).workspaces;
      assert.equal(bobWorkspaces.length, 1);
      assert.equal(bobWorkspaces[0]?.id, bobWorkspace.id);
      assert.equal(
        bobWorkspaces.some((w) => w.id === aliceWorkspace.id),
        false,
      );
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
