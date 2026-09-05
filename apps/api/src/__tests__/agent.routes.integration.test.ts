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
import { createDbClient, schema } from "@opensuite/db";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import {
  createStubEmailSender,
  extractEmailActionUrl,
} from "./support/stub-email-sender.js";
import { multipartFilePayload, testS3Env } from "./support/test-env.js";

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
  const email = `agent-http-${name}-${randomUUID()}@example.com`;
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
  assert.ok(setCookie);
  const cookie = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;

  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie, origin: config.webOrigin },
  });
  assert.equal(me.statusCode, 200, me.body);
  const userId = (me.json() as { user: { id: string } }).user.id;
  return { cookie, userId };
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

async function uploadDocument(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  cookie: string,
  workspaceId: string,
  filename = "brief.docx",
): Promise<string> {
  const file = multipartFilePayload(filename, Buffer.from("fake-office-bytes"));
  const response = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/documents`,
    headers: {
      ...file.headers,
      cookie,
      origin: config.webOrigin,
    },
    payload: file.payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { document: { id: string } }).document.id;
}

test(
  "agent HTTP: threads, messages, synchronous runs, ownership, errors",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage();

    let destructiveExecuted = false;
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage,
      agent: {
        model: createScriptedAgentModel([
          // first successful run
          assistantOnlyResponse("First answer"),
          // second run reuses context
          (request) => {
            const turns = request.messages.filter(
              (m) => m.role === "user" || m.role === "assistant",
            );
            assert.ok(
              turns.some(
                (m) => m.role === "user" && m.content === "First instruction",
              ),
            );
            assert.ok(
              turns.some(
                (m) => m.role === "assistant" && m.content === "First answer",
              ),
            );
            return assistantOnlyResponse("Second answer");
          },
          // tool run for steps
          toolCallResponse("", [
            { id: "t1", name: "document.inspect", input: { q: "intro" } },
          ]),
          assistantOnlyResponse("Inspected"),
          // model failure
          () => {
            throw new Error("provider boom should not leak");
          },
          // destructive confirmation deny-by-default
          toolCallResponse("", [
            { id: "d1", name: "slides.delete_slide", input: { index: 0 } },
          ]),
          assistantOnlyResponse("Skipped delete"),
          // cancellation (slow then abort)
          async (request) => {
            await delay(5_000, request.signal);
            return assistantOnlyResponse("should not finish");
          },
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "document.inspect",
            async execute() {
              return { summary: "looked" };
            },
          }),
          createFakeTool({
            name: "slides.delete_slide",
            risk: "destructive",
            async execute() {
              destructiveExecuted = true;
              return { summary: "deleted" };
            },
          }),
        ]),
        // no confirmation gate → deny destructive
      },
    });

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "alice",
      );
      const bob = await signUpVerifyAndSignIn(app, config, emailSender, "bob");
      const aliceWorkspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Alice WS",
      );
      const bobWorkspaceId = await createWorkspace(
        app,
        config,
        bob.cookie,
        "Bob WS",
      );
      const aliceDocId = await uploadDocument(
        app,
        config,
        alice.cookie,
        aliceWorkspaceId,
      );
      const bobDocId = await uploadDocument(
        app,
        config,
        bob.cookie,
        bobWorkspaceId,
        "bob.docx",
      );

      // --- THREAD CREATE auth / ownership ---
      const unauthCreate = await app.inject({
        method: "POST",
        url: `/api/documents/${aliceDocId}/agent/threads`,
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: { title: "Rewrite" },
      });
      assert.equal(unauthCreate.statusCode, 401);
      assert.equal(unauthCreate.json().error.code, "UNAUTHENTICATED");

      const missingDoc = await app.inject({
        method: "POST",
        url: `/api/documents/${randomUUID()}/agent/threads`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: {},
      });
      assert.equal(missingDoc.statusCode, 404);
      assert.equal(missingDoc.json().error.code, "DOCUMENT_NOT_FOUND");

      const crossCreate = await app.inject({
        method: "POST",
        url: `/api/documents/${bobDocId}/agent/threads`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { title: "Nope" },
      });
      assert.equal(crossCreate.statusCode, 404);
      assert.equal(crossCreate.json().error.code, "DOCUMENT_NOT_FOUND");

      const createThread = await app.inject({
        method: "POST",
        url: `/api/documents/${aliceDocId}/agent/threads`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { title: "  Rewrite intro  " },
      });
      assert.equal(createThread.statusCode, 201, createThread.body);
      const thread = (
        createThread.json() as {
          thread: {
            id: string;
            workspaceId: string;
            documentId: string;
            title: string;
          };
        }
      ).thread;
      assert.equal(thread.workspaceId, aliceWorkspaceId);
      assert.equal(thread.documentId, aliceDocId);
      assert.equal(thread.title, "Rewrite intro");
      assert.equal(
        "createdByUserId" in (createThread.json() as { thread: object }).thread,
        false,
      );

      // --- GET THREAD ---
      const unauthGet = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${thread.id}`,
      });
      assert.equal(unauthGet.statusCode, 401);

      const crossGet = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${thread.id}`,
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(crossGet.statusCode, 404);
      assert.equal(crossGet.json().error.code, "THREAD_NOT_FOUND");

      const getThread = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${thread.id}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(getThread.statusCode, 200);
      assert.equal(getThread.json().thread.id, thread.id);
      assert.equal(getThread.json().thread.documentId, aliceDocId);

      // --- RUN success + context reuse ---
      const unauthRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: { instruction: "Hello" },
      });
      assert.equal(unauthRun.statusCode, 401);

      const emptyInstruction = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "   " },
      });
      assert.equal(emptyInstruction.statusCode, 400);
      assert.equal(
        emptyInstruction.json().error.code,
        "INVALID_AGENT_INSTRUCTION",
      );

      const crossRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: bob.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Hack" },
      });
      assert.equal(crossRun.statusCode, 404);
      assert.equal(crossRun.json().error.code, "THREAD_NOT_FOUND");

      const run1 = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "First instruction" },
      });
      assert.equal(run1.statusCode, 200, run1.body);
      const run1Body = run1.json() as {
        run: { id: string; status: string };
        userMessage: { role: string; content: string };
        assistantMessage: { role: string; content: string } | null;
        steps: unknown[];
      };
      assert.equal(run1Body.run.status, "completed");
      assert.equal(run1Body.userMessage.role, "user");
      assert.equal(run1Body.userMessage.content, "First instruction");
      assert.equal(run1Body.assistantMessage?.content, "First answer");
      assert.ok(Array.isArray(run1Body.steps));
      assert.equal(
        run1Body.steps.every(
          (step) =>
            typeof step === "object" &&
            step !== null &&
            !("input" in step) &&
            !("output" in step),
        ),
        true,
      );

      const run2 = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Second instruction" },
      });
      assert.equal(run2.statusCode, 200, run2.body);
      assert.equal(run2.json().assistantMessage.content, "Second answer");

      // --- MESSAGES chronological, no tool transcript ---
      const messages = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${thread.id}/messages`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(messages.statusCode, 200);
      const messageList = (
        messages.json() as {
          messages: Array<{ role: string; content: string }>;
        }
      ).messages;
      assert.deepEqual(
        messageList.map((m) => ({ role: m.role, content: m.content })),
        [
          { role: "user", content: "First instruction" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second instruction" },
          { role: "assistant", content: "Second answer" },
        ],
      );

      const crossMessages = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${thread.id}/messages`,
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(crossMessages.statusCode, 404);

      // --- TOOL STEPS ---
      const toolRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Inspect please" },
      });
      assert.equal(toolRun.statusCode, 200, toolRun.body);
      const steps = (
        toolRun.json() as {
          steps: Array<{
            kind: string;
            name: string;
            status: string;
            sequence: number;
          }>;
        }
      ).steps;
      assert.ok(steps.length >= 1);
      assert.equal(steps[0]?.kind, "tool");
      assert.equal(steps[0]?.name, "document.inspect");
      assert.equal(steps[0]?.status, "completed");
      assert.equal(steps[0]?.sequence, 0);
      assert.ok(steps[0]);
      assert.equal(
        Object.prototype.hasOwnProperty.call(steps[0], "input"),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(steps[0], "output"),
        false,
      );

      // --- FAILURE mapping ---
      const failRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "This will fail" },
      });
      assert.equal(failRun.statusCode, 500, failRun.body);
      const failBody = failRun.json() as {
        error: { code: string; message: string };
        run: { id: string; status: string };
      };
      assert.equal(failBody.error.code, "AGENT_EXECUTION_FAILED");
      assert.equal(failBody.error.message.includes("provider boom"), false);
      assert.equal(failBody.run.status, "failed");

      const [failedRow] = await dbClient.db
        .select({
          status: schema.agentRun.status,
          errorMessage: schema.agentRun.errorMessage,
        })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.id, failBody.run.id));
      assert.equal(failedRow?.status, "failed");
      assert.ok(failedRow?.errorMessage);
      assert.equal(failedRow?.errorMessage.includes("provider boom"), true);
      // HTTP response must not leak that string — durable field may store safe model message
      assert.notEqual(failBody.error.message, failedRow?.errorMessage);

      // --- CONFIRMATION deny by default ---
      destructiveExecuted = false;
      const denyRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${thread.id}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delete a slide" },
      });
      assert.equal(denyRun.statusCode, 200, denyRun.body);
      assert.equal(destructiveExecuted, false);
      const denySteps = (
        denyRun.json() as {
          steps: Array<{ kind: string; status: string; name: string }>;
        }
      ).steps;
      assert.ok(
        denySteps.some(
          (step) => step.kind === "confirmation" && step.status === "failed",
        ),
      );

      // --- CANCELLATION via real HTTP abort ---
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const cancelController = new AbortController();
      const cancelFetch = fetch(`${baseUrl}/api/agent/threads/${thread.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        body: JSON.stringify({ instruction: "Cancel this run" }),
        signal: cancelController.signal,
      });
      await delay(100);
      cancelController.abort();
      await assert.rejects(() => cancelFetch);

      // Allow persistence finalize to settle.
      await delay(500);
      const cancelledRuns = await dbClient.db
        .select({
          status: schema.agentRun.status,
          errorCode: schema.agentRun.errorCode,
        })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.threadId, thread.id));
      assert.ok(
        cancelledRuns.some((run) => run.status === "cancelled"),
        `expected a cancelled run, got ${JSON.stringify(cancelledRuns)}`,
      );
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
