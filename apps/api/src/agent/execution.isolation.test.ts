import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunAgentResult, V3Model } from "@opensuite/agent-core-v3";

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
  AgentThreadContextCheckpoint,
} from "./persistence.js";
import { createAgentRunManager } from "./run-manager.js";
import { MAX_HISTORY_MESSAGES } from "./context-projection.js";

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
  messages: AgentMessage[];
  checkpoint: AgentThreadContextCheckpoint | null;
  runs: Map<string, AgentRun>;
  failOnStatus?: AgentRun["status"];
} {
  const thread = stubThread(ownerUserId);
  const messages: AgentMessage[] = [];
  const runs = new Map<string, AgentRun>();
  let messageSeq = 0;
  let runSeq = 0;

  const api = {
    messages,
    checkpoint: null as AgentThreadContextCheckpoint | null,
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
    async getLatestThreadContextCheckpoint() {
      return api.checkpoint;
    },
    async listMessagesAfterThreadContextCheckpoint(input: {
      checkpoint: AgentThreadContextCheckpoint;
    }) {
      const boundary = messages.findIndex(
        (message) => message.id === input.checkpoint.throughMessageId,
      );
      return boundary < 0 ? [] : messages.slice(boundary + 1);
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
    messages: AgentMessage[];
    checkpoint: AgentThreadContextCheckpoint | null;
    runs: Map<string, AgentRun>;
    failOnStatus?: AgentRun["status"];
  };
}

function softResult(
  stopReason: RunAgentResult["stopReason"],
  text = "",
): RunAgentResult {
  return {
    text,
    finishReason: "stop",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turns: 1,
    toolCalls: 0,
    stopReason,
    metrics: {
      startedAtMs: 0,
      completedAtMs: 0,
      modelTurns: [],
      toolCalls: [],
      fuseEvents: [],
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      stopReason,
    },
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
      createBlankDocxDocument: async () => {
        throw new Error("no blank");
      },
      createOfficeDocumentFromBytes: async () => {
        throw new Error("no create");
      },
    },
    resolveModel: async () => ({
      model: { provider: "test", modelId: "test" } as unknown as V3Model,
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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

test("successful V3 finish_tool settles completed + agent.completed", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  let sawSystem: string | undefined;
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      sawSystem = input.system;
      return softResult("finish_tool", "All done");
    }),
  );

  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "edit",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    })
  ).result;

  assert.equal(result.run.status, "completed");
  assert.equal(result.assistantMessage?.content, "All done");
  assert.ok(events.some((e) => e.type === "agent.completed"));
  assert.equal(events.some((e) => e.type === "agent.failed"), false);
  assert.ok(sawSystem);
  assert.match(sawSystem!, /You are OpenSuite's document agent/);
  assert.match(sawSystem!, /AVAILABLE CAPABILITIES/);
  assert.match(sawSystem!, /Use the finish operation when the requested work is complete/);
  // Isolation fixture has no bound DOCX → only finish is exposed.
  assert.match(sawSystem!, /- finish/);
  assert.equal(sawSystem!.includes("document."), false);
  assert.equal(sawSystem!.includes("document.capabilities"), false);
});

test("successful V3 completed (no tools) settles completed", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("completed", "Hello")),
  );
  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "hi",
    })
  ).result;
  assert.equal(result.run.status, "completed");
});

test("execution sends a bounded historical tail while retaining full persistence", async () => {
  const persistence = memoryPersistence("user-1");
  const history = Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, (_, index) => ({
    id: `history-${index}`,
    threadId: "thread-1",
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `history-${index}`,
    createdAt: now(),
  }));
  persistence.messages.push(...history);
  let modelMessages: readonly { readonly role: string; readonly content: unknown }[] = [];
  let sawSystem = "";
  let sawFinish = false;
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      modelMessages = input.messages as typeof modelMessages;
      sawSystem = input.system ?? "";
      sawFinish = "finish" in (input.tools ?? {});
      return softResult("completed", "done");
    }),
  );

  await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "current request stays complete",
    })
  ).result;

  const historical = modelMessages.slice(0, -1);
  assert.equal(historical.length, MAX_HISTORY_MESSAGES);
  assert.equal(modelMessages.filter((message) => message.content === "current request stays complete").length, 1);
  assert.equal(modelMessages.some((message) => message.content === "history-0"), false);
  assert.equal(modelMessages.some((message) => message.content === `history-${history.length - 1}`), true);
  assert.equal(persistence.messages.length, history.length + 2);
  assert.equal(persistence.messages.some((message) => message.content === "history-0"), true);
  assert.match(sawSystem, /You are OpenSuite's document agent/);
  assert.equal(sawFinish, true);
});

test("execution replaces checkpointed history with one checkpoint message", async () => {
  const persistence = memoryPersistence("user-1");
  const history = Array.from({ length: 110 }, (_, index) => ({
    id: `history-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `history-${index}`,
    createdAt: now(),
  }));
  persistence.messages.push(...history);
  persistence.checkpoint = {
    id: "checkpoint-1",
    threadId: "thread-1",
    throughMessageId: history[59]!.id,
    throughMessageCreatedAt: history[59]!.createdAt,
    contentVersion: 1,
    content: "User wants a concise launch plan.",
    sourceMessageCount: 60,
    estimatedCharacters: 34,
    createdAt: now(),
  };
  let modelMessages: readonly { readonly content: unknown }[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      modelMessages = input.messages as typeof modelMessages;
      return softResult("completed", "done");
    }),
  );

  await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "current request stays complete",
    })
  ).result;

  assert.equal(modelMessages.length, 42);
  assert.match(String(modelMessages[0]?.content), /Historical conversation checkpoint through history-059/);
  assert.match(String(modelMessages[0]?.content), /concise launch plan/);
  assert.equal(modelMessages.some((message) => message.content === "history-0"), false);
  assert.equal(modelMessages.some((message) => message.content === "history-60"), false);
  assert.equal(modelMessages.some((message) => message.content === "history-70"), true);
  assert.equal(modelMessages.filter((message) => message.content === "current request stays complete").length, 1);
  assert.equal(persistence.messages.length, 112);
  assert.equal(persistence.messages.some((message) => message.content === "history-0"), true);
});

test("max_turns soft stop becomes failed + AGENT_MAX_TURNS, not completed", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("max_turns")),
  );

  const unhandled = await collectUnhandledRejections(async () => {
    const result = await (
      await execution.start({
        userId: "user-1",
        threadId: "thread-1",
        instruction: "edit the doc",
        liveEvents: {
          emit(event) {
            events.push(event);
          },
        },
      })
    ).result;
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.errorCode, "AGENT_MAX_TURNS");
    assert.equal(result.assistantMessage, null);
  });

  assert.equal(unhandled.length, 0);
  assert.ok(events.some((event) => event.type === "agent.failed"));
  assert.equal(events.some((e) => e.type === "agent.completed"), false);
  const failed = events.find((e) => e.type === "agent.failed");
  assert.equal(failed && failed.type === "agent.failed" && failed.code, "AGENT_MAX_TURNS");
});

test("deadline soft stop becomes failed + AGENT_DEADLINE, not completed", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("deadline")),
  );

  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "edit",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    })
  ).result;

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_DEADLINE");
  assert.ok(events.some((e) => e.type === "agent.failed"));
  assert.equal(events.some((e) => e.type === "agent.completed"), false);
});

test("arbitrary runAgent throw is isolated as failed product state", async () => {
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

test("persistence failure while recording failure stays contained", async () => {
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

test("event relay maps V3 tool_skipped onto product tool.failed", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      await input.onEvent?.({
        type: "tool_skipped",
        toolCallId: "c1",
        toolName: "document.replace_text",
        reason: "FUSE_TRIPPED",
      });
      return softResult("finish_tool", "ok");
    }),
  );

  await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "edit",
      liveEvents: {
        emit(event) {
          events.push(event);
        },
      },
    })
  ).result;

  const failed = events.find((e) => e.type === "tool.failed");
  assert.ok(failed);
  assert.equal(failed.type === "tool.failed" && failed.error, "FUSE_TRIPPED");
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
