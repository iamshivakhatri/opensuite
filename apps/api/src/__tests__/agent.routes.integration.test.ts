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
  const email = `agent-live-${name}-${randomUUID()}@example.com`;
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
  return {
    cookie,
    userId: (me.json() as { user: { id: string } }).user.id,
  };
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

async function waitForRunStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  origin: string,
  runId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<{
  run: { id: string; status: string };
  steps: Array<{ kind: string; name: string; status: string; sequence: number }>;
}> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent/runs/${runId}`,
      headers: { cookie, origin },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      run: { id: string; status: string };
      steps: Array<{
        kind: string;
        name: string;
        status: string;
        sequence: number;
      }>;
    };
    if (body.run.status === status) {
      return body;
    }
    await delay(40);
  }
  throw new Error(`Timed out waiting for run ${runId} status=${status}`);
}

function parseSseChunks(text: string): Array<{
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
}> {
  const events: Array<{
    id?: string;
    event?: string;
    data?: Record<string, unknown>;
  }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) {
      continue;
    }
    let id: string | undefined;
    let event: string | undefined;
    let dataRaw: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataRaw = line.slice(5).trim();
    }
    if (dataRaw) {
      events.push({
        id,
        event,
        data: JSON.parse(dataRaw) as Record<string, unknown>,
      });
    }
  }
  return events;
}

async function readSseUntilTerminal(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 10_000,
): Promise<ReturnType<typeof parseSseChunks>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      assert.fail(
        `SSE expected 200, got ${response.status}: ${await response.text()}`,
      );
    }
    assert.ok(
      response.headers.get("content-type")?.includes("text/event-stream"),
    );
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = parseSseChunks(buffer);
      if (
        events.some(
          (e) =>
            e.event === "agent.completed" ||
            e.event === "agent.failed" ||
            e.event === "agent.cancelled",
        )
      ) {
        await reader.cancel().catch(() => undefined);
        return events;
      }
    }
    return parseSseChunks(buffer);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "agent HTTP live runs: 202, GET run, SSE, ownership, recovery",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage();
    const documents = createDocumentService(dbClient.db, storage, {
      uploadMaxBytes: config.uploadMaxBytes,
    });
    const persistence = createAgentPersistenceService(dbClient.db);

    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let destructiveExecuted = false;

    const model = createScriptedAgentModel([
      async () => {
        await slowGate;
        return assistantOnlyResponse("Delayed answer");
      },
      (request) => {
        const turns = request.messages.filter(
          (m) => m.role === "user" || m.role === "assistant",
        );
        assert.ok(
          turns.some(
            (m) => m.role === "user" && m.content === "Delayed instruction",
          ),
        );
        assert.ok(
          turns.some(
            (m) => m.role === "assistant" && m.content === "Delayed answer",
          ),
        );
        return assistantOnlyResponse("Second answer");
      },
      toolCallResponse("", [
        { id: "t1", name: "document.inspect", input: { q: "x" } },
      ]),
      assistantOnlyResponse("Inspected"),
      () => {
        throw new Error("provider boom should not leak");
      },
      toolCallResponse("", [
        { id: "d1", name: "slides.delete_slide", input: {} },
      ]),
      assistantOnlyResponse("Skipped"),
      async (request) => {
        await delay(8_000, request.signal);
        return assistantOnlyResponse("should not finish");
      },
    ]);

    const tools = ToolRegistry.create([
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
          return true;
        },
      }),
    ]);

    const execution = createAgentExecutionService({
      persistence,
      documents,
      model,
      tools,
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
        liveGraceMs: 200,
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

      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/documents/${bobDocId}/agent/threads`,
            headers: {
              "content-type": "application/json",
              cookie: alice.cookie,
              origin: config.webOrigin,
            },
            payload: {},
          })
        ).statusCode,
        404,
      );

      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/api/documents/${bobDocId}/agent/threads`,
            headers: {
              cookie: alice.cookie,
              origin: config.webOrigin,
            },
          })
        ).statusCode,
        404,
      );

      const olderThread = await app.inject({
        method: "POST",
        url: `/api/documents/${aliceDocId}/agent/threads`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { title: "Older" },
      });
      assert.equal(olderThread.statusCode, 201, olderThread.body);
      await delay(20);

      const createThread = await app.inject({
        method: "POST",
        url: `/api/documents/${aliceDocId}/agent/threads`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { title: "Live" },
      });
      assert.equal(createThread.statusCode, 201, createThread.body);
      const threadId = (
        createThread.json() as { thread: { id: string } }
      ).thread.id;

      const listThreads = await app.inject({
        method: "GET",
        url: `/api/documents/${aliceDocId}/agent/threads`,
        headers: {
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
      });
      assert.equal(listThreads.statusCode, 200, listThreads.body);
      const listed = (
        listThreads.json() as {
          threads: Array<{
            id: string;
            documentId: string | null;
            title: string | null;
          }>;
        }
      ).threads;
      assert.ok(listed.length >= 2);
      assert.equal(listed[0]?.id, threadId);
      assert.ok(listed.every((t) => t.documentId === aliceDocId));
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/api/documents/${aliceDocId}/agent/threads`,
            headers: {
              cookie: bob.cookie,
              origin: config.webOrigin,
            },
          })
        ).statusCode,
        404,
      );

      const postStart = Date.now();
      const postRun = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delayed instruction" },
      });
      assert.equal(postRun.statusCode, 202, postRun.body);
      assert.ok(Date.now() - postStart < 500);
      const queued = postRun.json() as {
        run: { id: string; status: string; threadId: string };
      };
      assert.equal(queued.run.status, "queued");
      assert.equal(queued.run.threadId, threadId);

      const mid = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${queued.run.id}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(mid.statusCode, 200);
      assert.ok(["queued", "running"].includes(mid.json().run.status));

      releaseSlow!();
      await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        queued.run.id,
        "completed",
      );

      const messages = await app.inject({
        method: "GET",
        url: `/api/agent/threads/${threadId}/messages`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      const messagesBody = messages.json() as {
        messages: Array<{ role: string; content: string }>;
        latestRun: { id: string; status: string } | null;
      };
      assert.deepEqual(
        messagesBody.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        [
          { role: "user", content: "Delayed instruction" },
          { role: "assistant", content: "Delayed answer" },
        ],
      );
      assert.equal(messagesBody.latestRun?.id, queued.run.id);
      assert.equal(messagesBody.latestRun?.status, "completed");

      const post2 = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Second instruction" },
      });
      assert.equal(post2.statusCode, 202);
      await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        post2.json().run.id,
        "completed",
      );

      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/api/agent/runs/${queued.run.id}`,
            headers: { cookie: bob.cookie, origin: config.webOrigin },
          })
        ).statusCode,
        404,
      );

      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/agent/threads/${threadId}/runs`,
            headers: {
              "content-type": "application/json",
              cookie: alice.cookie,
              origin: config.webOrigin,
            },
            payload: { instruction: "  " },
          })
        ).json().error.code,
        "INVALID_AGENT_INSTRUCTION",
      );

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const sseHeaders = {
        cookie: alice.cookie,
        origin: config.webOrigin,
      };

      const toolPost = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Inspect please" },
      });
      assert.equal(toolPost.statusCode, 202);
      const toolRunId = (toolPost.json() as { run: { id: string } }).run.id;

      const [sseA, sseB] = await Promise.all([
        readSseUntilTerminal(
          `${baseUrl}/api/agent/runs/${toolRunId}/events`,
          sseHeaders,
        ),
        readSseUntilTerminal(
          `${baseUrl}/api/agent/runs/${toolRunId}/events`,
          sseHeaders,
        ),
      ]);

      for (const events of [sseA, sseB]) {
        const types = events.map((e) => e.event);
        assert.deepEqual(
          types.filter((t) =>
            [
              "agent.started",
              "tool.started",
              "tool.completed",
              "agent.completed",
            ].includes(t ?? ""),
          ),
          [
            "agent.started",
            "tool.started",
            "tool.completed",
            "agent.completed",
          ],
        );
      }

      const toolSnapshot = await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        toolRunId,
        "completed",
      );
      assert.ok(toolSnapshot.steps.some((s) => s.name === "document.inspect"));

      const crossSse = await fetch(
        `${baseUrl}/api/agent/runs/${toolRunId}/events`,
        {
          headers: {
            cookie: bob.cookie,
            origin: config.webOrigin,
            accept: "text/event-stream",
          },
        },
      );
      assert.equal(crossSse.status, 404);

      const failPost = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "This will fail" },
      });
      assert.equal(failPost.statusCode, 202);
      const failRunId = (failPost.json() as { run: { id: string } }).run.id;
      const failEvents = await readSseUntilTerminal(
        `${baseUrl}/api/agent/runs/${failRunId}/events`,
        sseHeaders,
      );
      assert.ok(failEvents.some((e) => e.event === "agent.failed"));
      assert.equal(JSON.stringify(failEvents).includes("provider boom"), false);
      await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        failRunId,
        "failed",
      );

      destructiveExecuted = false;
      const denyPost = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Delete slide" },
      });
      assert.equal(denyPost.statusCode, 202);
      const denied = await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        (denyPost.json() as { run: { id: string } }).run.id,
        "completed",
      );
      assert.equal(destructiveExecuted, false);
      assert.ok(
        denied.steps.some(
          (s) => s.kind === "confirmation" && s.status === "failed",
        ),
      );

      // Cancelled terminal via HTTP cancel endpoint
      const cancelPost = await app.inject({
        method: "POST",
        url: `/api/agent/threads/${threadId}/runs`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { instruction: "Cancel me" },
      });
      assert.equal(cancelPost.statusCode, 202);
      const cancelRunId = (cancelPost.json() as { run: { id: string } }).run
        .id;

      const cancelSsePromise = readSseUntilTerminal(
        `${baseUrl}/api/agent/runs/${cancelRunId}/events`,
        sseHeaders,
      );
      await delay(80);

      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/agent/runs/${cancelRunId}/cancel`,
            headers: {
              cookie: bob.cookie,
              origin: config.webOrigin,
            },
          })
        ).statusCode,
        404,
      );

      const cancelHttp = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${cancelRunId}/cancel`,
        headers: {
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
      });
      assert.equal(cancelHttp.statusCode, 200, cancelHttp.body);
      assert.equal(
        (cancelHttp.json() as { run: { status: string } }).run.status,
        "cancelled",
      );

      const cancelEvents = await cancelSsePromise;
      assert.ok(cancelEvents.some((e) => e.event === "agent.cancelled"));
      await waitForRunStatus(
        app,
        alice.cookie,
        config.webOrigin,
        cancelRunId,
        "cancelled",
      );

      // Idempotent cancel on already-terminal run
      const cancelAgain = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${cancelRunId}/cancel`,
        headers: {
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
      });
      assert.equal(cancelAgain.statusCode, 200);
      assert.equal(
        (cancelAgain.json() as { run: { status: string } }).run.status,
        "cancelled",
      );

      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/agent/runs/${randomUUID()}/cancel`,
            headers: {
              cookie: alice.cookie,
              origin: config.webOrigin,
            },
          })
        ).statusCode,
        404,
      );

      // SSE disconnect unsubscribes without cancelling an active run
      // (verified structurally: cancel is explicit via POST /cancel only).

      // After live grace, completed run still recoverable from DB
      await delay(1_000);
      assert.equal(
        runManager.isLive(toolRunId),
        false,
        `expected tool run to leave live memory, active=${runManager._activeCount()}`,
      );
      const recovered = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${toolRunId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().run.status, "completed");
      assert.ok(recovered.json().steps.length >= 1);

      // SSE reconnect after live removal returns terminal hint then closes
      const staleSse = await fetch(
        `${baseUrl}/api/agent/runs/${toolRunId}/events`,
        {
          headers: {
            ...sseHeaders,
            accept: "text/event-stream",
          },
        },
      );
      assert.equal(staleSse.status, 200);
      const staleText = await staleSse.text();
      assert.ok(staleText.includes("agent.completed"));
      assert.ok(staleText.includes('"live":false'));
    } finally {
      try {
        await runManager.waitForIdle();
      } catch {
        // ignore
      }
      await app.close();
      await dbClient.close();
    }
  },
);
