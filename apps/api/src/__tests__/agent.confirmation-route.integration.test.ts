import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  ToolRegistry,
  assistantOnlyResponse,
  createFakeTool,
  createScriptedAgentModel,
  delay,
  toolCallResponse,
} from "@opensuite/agent-core";
import { createDbClient } from "@opensuite/db";

import { buildApp } from "../app.js";
import { createHttpConfirmationBridge } from "../agent/confirmation-bridge.js";
import { createAgentExecutionService } from "../agent/execution.js";
import { createAgentPersistenceService } from "../agent/persistence.js";
import { createAgentRunManager } from "../agent/run-manager.js";
import { createAuth } from "../auth/index.js";
import { loadConfig } from "../config/index.js";
import { createDocumentService } from "../documents/service.js";
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
  const email = `agent-confirm-${name}-${randomUUID()}@example.com`;
  const password = "password1234";

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json", origin: config.webOrigin },
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
    headers: { "content-type": "application/json", origin: config.webOrigin },
    payload: { email, password },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const setCookie = signIn.headers["set-cookie"];
  assert.ok(setCookie);
  const cookie = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;

  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie, origin: config.webOrigin },
  });
  assert.equal(me.statusCode, 200, me.body);
  return { cookie, userId: (me.json() as { user: { id: string } }).user.id };
}

async function createWorkspace(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  cookie: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: config.webOrigin,
    },
    payload: { name },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { workspace: { id: string } }).workspace.id;
}

async function createWorkspaceThread(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  cookie: string,
  workspaceId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/agent/threads`,
    headers: {
      "content-type": "application/json",
      cookie,
      origin: config.webOrigin,
    },
    payload: {},
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { thread: { id: string } }).thread.id;
}

async function waitForRunStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  origin: string,
  runId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<{ run: { id: string; status: string } }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent/runs/${runId}`,
      headers: { cookie, origin },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { run: { id: string; status: string } };
    if (body.run.status === status) {
      return body;
    }
    await delay(40);
  }
  throw new Error(`Timed out waiting for run ${runId} status=${status}`);
}

/** Poll GET /runs/:id until status is `waiting_for_confirmation`. */
async function waitForPendingConfirmation(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  origin: string,
  runId: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitForRunStatus(
    app,
    cookie,
    origin,
    runId,
    "waiting_for_confirmation",
    timeoutMs,
  );
}

async function setup(destructiveExecuted: { value: boolean }) {
  const config = testConfig();
  const dbClient = createDbClient({ databaseUrl: databaseUrl! });
  const emailSender = createStubEmailSender();
  const auth = createAuth(config, dbClient.db, emailSender);
  const storage = createMemoryObjectStorage();
  const documents = createDocumentService(dbClient.db, storage, {
    uploadMaxBytes: config.uploadMaxBytes,
  });
  const persistence = createAgentPersistenceService(dbClient.db);
  const confirmationBridge = createHttpConfirmationBridge();

  const model = createScriptedAgentModel([
    toolCallResponse("", [
      { id: "call-1", name: "slides.delete_slide", input: {} },
    ]),
    assistantOnlyResponse("Turn finished"),
  ]);
  const tools = ToolRegistry.create([
    createFakeTool({
      name: "slides.delete_slide",
      risk: "destructive",
      async execute() {
        destructiveExecuted.value = true;
        return true;
      },
    }),
  ]);

  const execution = createAgentExecutionService({
    persistence,
    documents,
    model,
    tools,
    confirmation: confirmationBridge,
  });
  const runManager = createAgentRunManager({
    execution,
    persistence,
    liveGraceMs: 200,
  });

  const app = await buildApp(config, {
    auth,
    db: dbClient.db,
    storage,
    agent: {
      persistence,
      execution,
      runManager,
      model,
      tools,
      confirmationBridge,
      liveGraceMs: 200,
    },
  });

  return { app, config, dbClient, emailSender };
}

test(
  "agent confirmation HTTP route: approve executes, ownership + staleness enforced",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const destructiveExecuted = { value: false };
    const { app, config, dbClient, emailSender } = await setup(destructiveExecuted);

    try {
      const alice = await signUpVerifyAndSignIn(app, config, emailSender, "alice");
      const bob = await signUpVerifyAndSignIn(app, config, emailSender, "bob");
      const workspaceId = await createWorkspace(app, config, alice.cookie, "WS");
      const threadId = await createWorkspaceThread(
        app,
        config,
        alice.cookie,
        workspaceId,
      );

      const started = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delete slide" },
      });
      assert.equal(started.statusCode, 202, started.body);
      const runId = (started.json() as { run: { id: string } }).run.id;

      await waitForPendingConfirmation(app, alice.cookie, config.webOrigin, runId);

      // Unauthenticated attempt.
      const unauthed = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      assert.equal(unauthed.statusCode, 401);

      // Wrong owner — must not be able to discover or resolve Alice's run.
      const crossOwner = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: bob.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      assert.equal(crossOwner.statusCode, 404);
      assert.equal(destructiveExecuted.value, false);

      // Stale/unknown toolCallId from the actual owner.
      const staleAttempt = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "not-the-real-call", decision: "approve" },
      });
      assert.equal(staleAttempt.statusCode, 409);
      assert.equal(
        (staleAttempt.json() as { error: { code: string } }).error.code,
        "CONFIRMATION_NOT_PENDING",
      );
      assert.equal(destructiveExecuted.value, false);

      // Real approve — the waiting tool call continues exactly once.
      const approve = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      assert.equal(approve.statusCode, 200, approve.body);

      await waitForRunStatus(app, alice.cookie, config.webOrigin, runId, "completed");
      assert.equal(destructiveExecuted.value, true);

      // Duplicate approve after resolution is rejected cleanly.
      const duplicate = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      assert.equal(duplicate.statusCode, 409);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "agent confirmation HTTP route: deny resolves through existing skipped behavior",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const destructiveExecuted = { value: false };
    const { app, config, dbClient, emailSender } = await setup(destructiveExecuted);

    try {
      const alice = await signUpVerifyAndSignIn(app, config, emailSender, "alice");
      const workspaceId = await createWorkspace(app, config, alice.cookie, "WS");
      const threadId = await createWorkspaceThread(
        app,
        config,
        alice.cookie,
        workspaceId,
      );

      const started = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delete slide" },
      });
      assert.equal(started.statusCode, 202, started.body);
      const runId = (started.json() as { run: { id: string } }).run.id;

      await waitForPendingConfirmation(app, alice.cookie, config.webOrigin, runId);

      const deny = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "call-1", decision: "deny" },
      });
      assert.equal(deny.statusCode, 200, deny.body);

      const finished = await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        runId,
        "completed",
      );
      assert.equal(finished.run.status, "completed");
      assert.equal(destructiveExecuted.value, false);

      const stepsResponse = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${runId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      const steps = (
        stepsResponse.json() as {
          steps: Array<{ kind: string; status: string }>;
        }
      ).steps;
      assert.ok(
        steps.some((s) => s.kind === "confirmation" && s.status === "failed"),
      );
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "agent confirmation HTTP route: cancelling while waiting leaves nothing pending",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const destructiveExecuted = { value: false };
    const { app, config, dbClient, emailSender } = await setup(destructiveExecuted);

    try {
      const alice = await signUpVerifyAndSignIn(app, config, emailSender, "alice");
      const workspaceId = await createWorkspace(app, config, alice.cookie, "WS");
      const threadId = await createWorkspaceThread(
        app,
        config,
        alice.cookie,
        workspaceId,
      );

      const started = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delete slide" },
      });
      assert.equal(started.statusCode, 202, started.body);
      const runId = (started.json() as { run: { id: string } }).run.id;

      await waitForPendingConfirmation(app, alice.cookie, config.webOrigin, runId);

      const cancel = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/cancel`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(cancel.statusCode, 200, cancel.body);
      assert.equal(
        (cancel.json() as { run: { status: string } }).run.status,
        "cancelled",
      );
      assert.equal(destructiveExecuted.value, false);

      // Nothing left to approve/deny after cancellation.
      const lateDecision = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/confirmation`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      assert.equal(lateDecision.statusCode, 409);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
