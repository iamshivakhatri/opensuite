import assert from "node:assert/strict";
import { test } from "node:test";

import { MaxTurnsExceededError, type V2Model } from "@opensuite/agent-core-v2";

import {
  createAgentExecutionService,
  type AgentEvent,
  type AgentExecutionServiceDeps,
} from "./execution.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentRun,
  AgentThread,
} from "./persistence.js";
import { createAgentRunManager } from "./run-manager.js";

const now = () => new Date().toISOString();

function stubThread(ownerUserId: string): AgentThread {
  return {
    id: "thread-1",
    workspaceId: "ws-1",
    documentId: null,
    createdByUserId: ownerUserId,
    title: null,
    createdAt: now(),
    updatedAt: now(),
    archivedAt: null,
  };
}

function memoryPersistence(ownerUserId: string): AgentPersistenceService & {
  runs: Map<string, AgentRun>;
  failOnStatus?: AgentRun["status"];
} {
  const thread = stubThread(ownerUserId);
  const messages: AgentMessage[] = [];
  const runs = new Map<string, AgentRun>();
  let messageSeq = 0;
  let runSeq = 0;

  const api = {
    runs,
    failOnStatus: undefined as AgentRun["status"] | undefined,
    async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
    async getOwnedThread() {
      return thread;
    },
    async appendMessage(input: {
      threadId: string;
      ownerUserId: string;
      role: AgentMessage["role"];
      content: string;
    }) {
      const message: AgentMessage = {
        id: `msg-${++messageSeq}`,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        createdAt: now(),
      };
      messages.push(message);
      return message;
    },
    async listMessagesForThread() {
      return [...messages];
    },
    async createRun(input: {
      threadId: string;
      ownerUserId: string;
      createdByUserId: string;
      triggeringMessageId: string;
      baseDocumentVersionId: string | null;
      status: AgentRun["status"];
    }) {
      const run: AgentRun = {
        id: `run-${++runSeq}`,
        threadId: input.threadId,
        triggeringMessageId: input.triggeringMessageId,
        createdByUserId: input.createdByUserId,
        baseDocumentVersionId: input.baseDocumentVersionId,
        status: input.status,
        createdAt: now(),
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      };
      runs.set(run.id, run);
      return run;
    },
    async updateRunStatus(input: {
      runId: string;
      ownerUserId: string;
      status: AgentRun["status"];
      errorCode?: string;
      errorMessage?: string;
    }) {
      if (api.failOnStatus && input.status === api.failOnStatus) {
        throw new Error("persistence finalize boom");
      }
      const existing = runs.get(input.runId);
      assert.ok(existing);
      const updated: AgentRun = {
        ...existing,
        status: input.status,
        startedAt: existing.startedAt ?? now(),
        completedAt:
          input.status === "completed" ||
          input.status === "failed" ||
          input.status === "cancelled"
            ? now()
            : existing.completedAt,
        errorCode: input.errorCode ?? existing.errorCode,
        errorMessage: input.errorMessage ?? existing.errorMessage,
      };
      runs.set(input.runId, updated);
      return updated;
    },
    async getRun(input: { runId: string; ownerUserId: string }) {
      return runs.get(input.runId) ?? null;
    },
  };

  return api as unknown as AgentPersistenceService & {
    runs: Map<string, AgentRun>;
    failOnStatus?: AgentRun["status"];
  };
}

function baseDeps(
  persistence: AgentPersistenceService,
  runAgentImpl: NonNullable<AgentExecutionServiceDeps["runAgent"]>,
): AgentExecutionServiceDeps {
  return {
    persistence,
    documents: {
      getOwnedDocument: async () => {
        throw new Error("no document");
      },
      readExactVersionBytes: async () => Buffer.alloc(0),
      appendDocumentVersion: async () => {
        throw new Error("no append");
      },
    },
    resolveModel: async () => ({
      model: { provider: "test", modelId: "test" } as unknown as V2Model,
    }),
    runAgent: runAgentImpl,
  };
}

async function collectUnhandledRejections(
  work: () => Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await work();
    // Allow microtasks/macrotasks from finally chains to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

test("TEST A — maxTurns becomes failed run + agent.failed without escaping rejection", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => {
      throw new MaxTurnsExceededError(10);
    }),
  );

  const unhandled = await collectUnhandledRejections(async () => {
    const handle = await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "edit the doc",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    });
    const result = await handle.result;
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.errorCode, "AGENT_EXECUTION_FAILED");
    assert.equal(result.assistantMessage, null);
  });

  assert.equal(unhandled.length, 0);
  assert.ok(events.some((event) => event.type === "agent.failed"));
  assert.equal([...persistence.runs.values()][0]?.status, "failed");
});

test("TEST B — arbitrary runAgent throw is isolated as failed product state", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => {
      throw new Error("provider exploded");
    }),
  );

  const unhandled = await collectUnhandledRejections(async () => {
    const handle = await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "do work",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    });
    const result = await handle.result;
    assert.equal(result.run.status, "failed");
  });

  assert.equal(unhandled.length, 0);
  assert.ok(events.some((event) => event.type === "agent.failed"));
});

test("TEST C — persistence failure while recording failure stays contained", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.failOnStatus = "failed";
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => {
      throw new Error("runtime boom");
    }),
  );

  const unhandled = await collectUnhandledRejections(async () => {
    const handle = await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "do work",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    });
    const result = await handle.result;
    // Still settles; may use in-memory terminal snapshot when DB write failed.
    assert.equal(result.run.status, "failed");
  });

  assert.equal(unhandled.length, 0);
  assert.ok(events.some((event) => event.type === "agent.failed"));
});

test("cancellation remains cancelled, not failed", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  abort.abort();
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => {
      throw new Error("aborted");
    }),
  );

  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "stop me",
      signal: abort.signal,
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    })
  ).result;

  assert.equal(result.run.status, "cancelled");
  assert.ok(events.some((event) => event.type === "agent.cancelled"));
  assert.equal(
    events.some((event) => event.type === "agent.failed"),
    false,
  );
});

test("run-manager ownership: rejecting background result does not produce unhandledRejection", async () => {
  const persistence = memoryPersistence("user-1");
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<never>((_, reject) => {
    rejectResult = reject;
  });

  const execution = {
    async start() {
      const run: AgentRun = {
        id: "live-run-1",
        threadId: "thread-1",
        triggeringMessageId: "msg-1",
        createdByUserId: "user-1",
        baseDocumentVersionId: null,
        status: "running",
        createdAt: now(),
        startedAt: now(),
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      };
      return {
        thread: stubThread("user-1"),
        userMessage: {
          id: "msg-1",
          threadId: "thread-1",
          role: "user" as const,
          content: "go",
          createdAt: now(),
        },
        run,
        result: resultPromise,
      };
    },
  };

  const runManager = createAgentRunManager({
    execution: execution as never,
    persistence,
    liveGraceMs: 5,
  });

  const unhandled = await collectUnhandledRejections(async () => {
    await runManager.startRun({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "go",
    });
    rejectResult(new Error("legacy rejecting execution"));
    await runManager.waitForIdle();
  });

  assert.equal(unhandled.length, 0);
});
