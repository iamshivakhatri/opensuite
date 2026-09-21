import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunAgentResult, RunModelResult, V3Model } from "@opensuite/agent-core-v3";

import {
  boundedStopMessage,
  createAgentExecutionService,
  type AgentEvent,
  type AgentExecutionServiceDeps,
} from "./execution.js";
import { compactThreadContext } from "./context-compaction.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentRun,
  AgentThread,
  AgentThreadContextCheckpoint,
} from "./persistence.js";
import { createAgentRunManager } from "./run-manager.js";
import { estimateTokens, MAX_HISTORY_MESSAGES, safeInputTokenBudget } from "./context-projection.js";

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
  checkpoints: AgentThreadContextCheckpoint[];
  contextRowsLoaded: number[];
  compactionSourceRowsLoaded: number[];
  runs: Map<string, AgentRun>;
  steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null }[];
  failOnStatus?: AgentRun["status"];
} {
  const thread = stubThread(ownerUserId);
  const messages: AgentMessage[] = [];
  const runs = new Map<string, AgentRun>();
  const steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null }[] = [];
  let messageSeq = 0;
  let runSeq = 0;

  const api = {
    messages,
    checkpoint: null as AgentThreadContextCheckpoint | null,
    checkpoints: [] as AgentThreadContextCheckpoint[],
    contextRowsLoaded: [] as number[],
    compactionSourceRowsLoaded: [] as number[],
    runs,
    steps,
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
    async getLatestThreadContextCheckpoint() {
      return api.checkpoint;
    },
    async getMessageForThread(input: { messageId: string; threadId: string }) {
      return messages.find((message) => message.id === input.messageId && message.threadId === input.threadId) ?? null;
    },
    async listRecentMessagesForContext(input: {
      checkpoint?: AgentThreadContextCheckpoint | null;
      excludeMessageId?: string;
      limit: number;
    }) {
      const tail = input.checkpoint
        ? messages.filter((message) =>
            message.createdAt > input.checkpoint!.throughMessageCreatedAt ||
            (message.createdAt === input.checkpoint!.throughMessageCreatedAt &&
              message.id > input.checkpoint!.throughMessageId),
          )
        : messages;
      const result = [...tail]
        .filter((message) => message.id !== input.excludeMessageId)
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .slice(-input.limit);
      api.contextRowsLoaded.push(result.length);
      return result;
    },
    async getThreadContextTailStats(input: {
      checkpoint?: AgentThreadContextCheckpoint | null;
    }) {
      const tail = input.checkpoint
        ? messages.filter((message) =>
            message.createdAt > input.checkpoint!.throughMessageCreatedAt ||
            (message.createdAt === input.checkpoint!.throughMessageCreatedAt &&
              message.id > input.checkpoint!.throughMessageId),
          )
        : messages;
      return {
        messageCount: tail.length,
        characterCount: tail.reduce((total, message) => total + message.content.length, 0),
      };
    },
    async listOldestMessagesForContextCompaction(input: {
      checkpoint?: AgentThreadContextCheckpoint | null;
      limit: number;
    }) {
      const tail = input.checkpoint
        ? messages.filter((message) =>
            message.createdAt > input.checkpoint!.throughMessageCreatedAt ||
            (message.createdAt === input.checkpoint!.throughMessageCreatedAt &&
              message.id > input.checkpoint!.throughMessageId),
          )
        : messages;
      const result = [...tail]
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .slice(0, input.limit);
      api.compactionSourceRowsLoaded.push(result.length);
      return result;
    },
    async createThreadContextCheckpoint(input: {
      threadId: string;
      throughMessageId: string;
      content: string;
      sourceMessageCount: number;
    }) {
      const boundary = messages.find((message) => message.id === input.throughMessageId);
      assert.ok(boundary);
      const checkpoint: AgentThreadContextCheckpoint = {
        id: `checkpoint-${api.checkpoints.length + 1}`,
        threadId: input.threadId,
        throughMessageId: boundary.id,
        throughMessageCreatedAt: boundary.createdAt,
        contentVersion: 1,
        content: input.content,
        sourceMessageCount: input.sourceMessageCount,
        estimatedCharacters: input.content.length,
        createdAt: now(),
      };
      api.checkpoint = checkpoint;
      api.checkpoints.push(checkpoint);
      return checkpoint;
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
        resultMessageId: null,
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
      resultMessageId?: string | null;
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
        resultMessageId: input.resultMessageId ?? existing.resultMessageId,
      };
      runs.set(input.runId, updated);
      return updated;
    },
    async getRun(input: { runId: string; ownerUserId: string }) {
      return runs.get(input.runId) ?? null;
    },
    async appendSteps(input: { runId: string; steps: { runId?: string; sequence: number; kind: string; status: string; name: string; summary?: string | null }[] }) {
      steps.push(...input.steps.map((step) => ({ ...step, runId: input.runId })));
      return [];
    },
  };

  return api as unknown as AgentPersistenceService & {
    messages: AgentMessage[];
    checkpoint: AgentThreadContextCheckpoint | null;
    checkpoints: AgentThreadContextCheckpoint[];
    contextRowsLoaded: number[];
    compactionSourceRowsLoaded: number[];
    runs: Map<string, AgentRun>;
    steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null }[];
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
  runModelImpl?: NonNullable<AgentExecutionServiceDeps["runModel"]>,
  contextLength?: number,
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
      ...(contextLength !== undefined ? { contextLength } : {}),
    }),
    runAgent: runAgentImpl,
    ...(runModelImpl ? { runModel: runModelImpl } : {}),
  };
}

function checkpointResult(text: string): RunModelResult {
  return {
    text,
    finishReason: "stop",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turns: 1,
    toolCalls: 0,
  };
}

const validCheckpoint = `STANDING CONTEXT:\n- goal\nDECISIONS:\n- none\nCOMPLETED WORK:\n- none\nREFERENCES:\n- none\nOPEN ITEMS:\n- none`;

async function waitForCompaction(): Promise<void> {
  // Compaction is fire-and-forget after settle; drain a few turns so
  // checkpoint writes land before the next assertion/start.
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  assert.equal(result.run.resultMessageId, result.assistantMessage?.id);
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

test("completed runs persist narration at tool boundaries without duplicating the final answer", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      await input.onEvent?.({ type: "text_delta", delta: "I'll inspect the document." });
      await input.onEvent?.({ type: "tool_started", toolCallId: "inspect-1", toolName: "document.inspect" });
      await input.onEvent?.({ type: "tool_completed", toolCallId: "inspect-1", toolName: "document.inspect" });
      await input.onEvent?.({ type: "text_delta", delta: "Done." });
      return softResult("finish_tool", "Done.");
    }),
  );

  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "inspect" })).result;

  assert.deepEqual(
    persistence.steps.map((step) => [step.sequence, step.kind, step.status, step.name, step.summary]),
    [
      [0, "narration", "completed", "Assistant narration", "I'll inspect the document."],
      [1, "inspect", "completed", "document.inspect", "Completed"],
    ],
  );
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

test("execution loads at most forty history rows from a large thread", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.messages.push(...Array.from({ length: 10_000 }, (_, index) => ({
    id: `history-${String(index).padStart(5, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `history-${index}`,
    createdAt: now(),
  })));
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("completed", "done")),
  );

  await (await execution.start({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "current request",
  })).result;

  assert.deepEqual(persistence.contextRowsLoaded, [MAX_HISTORY_MESSAGES]);
  assert.equal(persistence.messages.length, 10_002);
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

test("known context budgets history before the complete current request", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.messages.push(...Array.from({ length: 10 }, (_, index) => ({
    id: `budget-${index}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `old-${index}-${"x".repeat(600)}`,
    createdAt: now(),
  })));
  let modelMessages: readonly { readonly content: unknown }[] = [];
  const current = "current request stays complete ".repeat(100);
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      modelMessages = input.messages as typeof modelMessages;
      return softResult("completed", "done");
    }, undefined, 1_000),
  );

  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: current })).result;

  assert.equal(modelMessages.at(-1)?.content, current);
  assert.equal(modelMessages.some((message) => String(message.content).includes("old-0-")), false);
});

test("successful long thread compacts only the old tail and keeps full history", async () => {
  const persistence = memoryPersistence("user-1");
  const history = Array.from({ length: 60 }, (_, index) => ({
    id: `history-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `history-${index}`,
    createdAt: now(),
  }));
  persistence.messages.push(...history);
  const inputs: string[] = [];
  const execution = createAgentExecutionService(
    baseDeps(
      persistence,
      async () => softResult("completed", "done"),
      async (input) => {
        inputs.push(String(input.messages[0]?.content));
        return checkpointResult(validCheckpoint);
      },
    ),
  );

  const result = await (
    await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "current" })
  ).result;
  await waitForCompaction();

  assert.equal(result.run.status, "completed");
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]!, /history-0/);
  assert.equal(inputs[0]!.includes("history-42"), false);
  assert.equal(persistence.checkpoints.length, 1);
  assert.equal(persistence.checkpoint?.throughMessageId, "history-041");
  assert.equal(persistence.checkpoint?.sourceMessageCount, 42);
  assert.equal(persistence.messages.length, 62);
  assert.ok(persistence.messages.some((message) => message.id === "history-000"));
});

test("later compaction uses the previous checkpoint and only new messages", async () => {
  const persistence = memoryPersistence("user-1");
  const initial = Array.from({ length: 60 }, (_, index) => ({
    id: `old-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `old-${index}`,
    createdAt: now(),
  }));
  persistence.messages.push(...initial);
  const inputs: string[] = [];
  const execution = createAgentExecutionService(
    baseDeps(
      persistence,
      async () => softResult("completed", "done"),
      async (input) => {
        inputs.push(String(input.messages[0]?.content));
        return checkpointResult(validCheckpoint);
      },
    ),
  );
  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "first" })).result;
  await waitForCompaction();
  persistence.messages.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `new-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "assistant" as const,
    content: `new-${index}`,
    createdAt: now(),
  })));

  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "second" })).result;
  await waitForCompaction();

  assert.equal(inputs.length, 2);
  assert.match(inputs[1]!, /PREVIOUS CHECKPOINT:[\s\S]*STANDING CONTEXT/);
  assert.equal(inputs[1]!.includes("old-0"), false);
  assert.match(inputs[1]!, /new-0/);
  assert.equal(persistence.checkpoints.length, 2);
  assert.equal(persistence.checkpoints[0]?.content, validCheckpoint);

  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "short tail" })).result;
  await waitForCompaction();
  assert.equal(inputs.length, 2);
});

test("character threshold compacts while retaining the latest twenty messages", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.messages.push(...Array.from({ length: 21 }, (_, index) => ({
    id: `large-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: "x".repeat(2_400),
    createdAt: now(),
  })));
  let calls = 0;
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("completed", "done"), async () => {
      calls += 1;
      return checkpointResult(validCheckpoint);
    }),
  );
  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "large" })).result;
  await waitForCompaction();

  assert.equal(calls, 1);
  assert.equal(persistence.checkpoint?.sourceMessageCount, 3);
  assert.equal(persistence.messages.length, 23);
});

test("a delayed older compaction result cannot replace a newer checkpoint", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.messages.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `race-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `race-${index}`,
    createdAt: now(),
  })));
  const result = await compactThreadContext({
    persistence,
    ownerUserId: "user-1",
    threadId: "thread-1",
    model: { provider: "test", modelId: "test" } as unknown as V3Model,
    runModel: async () => {
      await persistence.createThreadContextCheckpoint({
        threadId: "thread-1",
        ownerUserId: "user-1",
        throughMessageId: "race-050",
        content: validCheckpoint,
        sourceMessageCount: 51,
      });
      return checkpointResult(validCheckpoint);
    },
  });

  assert.equal(result.checkpointCreated, false);
  assert.equal(result.failureCode, "STALE_BOUNDARY");
  assert.equal(persistence.checkpoints.length, 1);
  assert.equal(persistence.checkpoint?.throughMessageId, "race-050");
});

test("compaction bounds a huge prefix and advances only through that prefix", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.messages.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `huge-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `huge-${index}-${"x".repeat(10_000)}`,
    createdAt: now(),
  })));
  let compactionInput = "";
  const result = await compactThreadContext({
    persistence,
    ownerUserId: "user-1",
    threadId: "thread-1",
    model: { provider: "test", modelId: "test" } as unknown as V3Model,
    contextLength: 1_000,
    runModel: async (input) => {
      compactionInput = String(input.messages[0]?.content);
      return checkpointResult(validCheckpoint);
    },
  });

  assert.equal(result.checkpointCreated, true);
  assert.equal(persistence.checkpoint?.throughMessageId, "huge-000");
  assert.equal(compactionInput.includes("huge-1-"), false);
  assert.deepEqual(persistence.compactionSourceRowsLoaded, [40]);
  assert.ok(estimateTokens(compactionInput) < safeInputTokenBudget(1_000));
  assert.equal(persistence.messages.length, 60);
});

test("short, failed, and malformed runs do not create a checkpoint", async () => {
  const persistence = memoryPersistence("user-1");
  let calls = 0;
  const shortExecution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("completed", "done"), async () => {
      calls += 1;
      return checkpointResult(validCheckpoint);
    }),
  );
  await (await shortExecution.start({ userId: "user-1", threadId: "thread-1", instruction: "short" })).result;
  await waitForCompaction();
  assert.equal(calls, 0);

  persistence.messages.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `long-${String(index).padStart(3, "0")}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `long-${index}`,
    createdAt: now(),
  })));
  const malformedExecution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("completed", "done"), async () => checkpointResult("not a checkpoint")),
  );
  await (await malformedExecution.start({ userId: "user-1", threadId: "thread-1", instruction: "long" })).result;
  await waitForCompaction();
  assert.equal(persistence.checkpoint, null);

  const failedExecution = createAgentExecutionService(
    baseDeps(persistence, async () => softResult("max_turns"), async () => {
      throw new Error("must not run");
    }),
  );
  await (await failedExecution.start({ userId: "user-1", threadId: "thread-1", instruction: "fail" })).result;
  await waitForCompaction();
  assert.equal(persistence.checkpoint, null);
});

test("max_turns settles as a bounded stop and persists its existing transcript", async () => {
  const persistence = memoryPersistence("user-1");
  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      await input.onEvent?.({ type: "text_delta", delta: "I found the section." });
      await input.onEvent?.({ type: "tool_started", toolCallId: "edit-1", toolName: "document.delete_paragraph" });
      await input.onEvent?.({ type: "tool_completed", toolCallId: "edit-1", toolName: "document.delete_paragraph" });
      return softResult("max_turns");
    }),
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
    assert.equal(result.run.errorMessage, "Stopped before completing the task.");
    assert.equal(result.assistantMessage, null);
  });

  assert.equal(unhandled.length, 0);
  assert.ok(events.some((event) => event.type === "agent.failed"));
  assert.equal(events.some((e) => e.type === "agent.completed"), false);
  const failed = events.find((e) => e.type === "agent.failed");
  assert.equal(failed && failed.type === "agent.failed" && failed.code, "AGENT_MAX_TURNS");
  assert.deepEqual(
    persistence.steps.map((step) => [step.kind, step.status, step.name, step.summary]),
    [
      ["narration", "completed", "Assistant narration", "I found the section."],
      ["tool", "completed", "document.delete_paragraph", "Completed"],
    ],
  );
});

test("max_turns reports preserved changes only after a version advance", () => {
  assert.equal(
    boundedStopMessage("max_turns", true),
    "Stopped before completing the task. Changes made so far were preserved.",
  );
  assert.equal(boundedStopMessage("max_turns", false), "Stopped before completing the task.");
});

test("continuation creates a fresh 20-turn run from the original task", async () => {
  const persistence = memoryPersistence("user-1");
  const original = await persistence.appendMessage({
    threadId: "thread-1",
    ownerUserId: "user-1",
    role: "user",
    content: "Rewrite the Risks section.",
  });
  const partial = await persistence.createRun({
    threadId: "thread-1",
    ownerUserId: "user-1",
    createdByUserId: "user-1",
    triggeringMessageId: original.id,
    status: "queued",
  });
  await persistence.updateRunStatus({
    runId: partial.id,
    ownerUserId: "user-1",
    status: "failed",
    errorCode: "AGENT_MAX_TURNS",
  });

  let observedMaxTurns: number | undefined;
  let observedModelText = "";
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      observedMaxTurns = input.maxTurns;
      observedModelText = input.messages.map((message) => String(message.content)).join("\n");
      return softResult("completed", "Done.");
    }),
  );
  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "Continue",
      continueFromRunId: partial.id,
    })
  ).result;

  assert.notEqual(result.run.id, partial.id);
  assert.equal(result.run.triggeringMessageId, original.id);
  assert.equal(result.userMessage.content, "Continue");
  assert.equal(persistence.runs.get(partial.id)?.status, "failed");
  assert.equal(observedMaxTurns, 20);
  assert.match(observedModelText, /Original task:\nRewrite the Risks section/);
  assert.match(observedModelText, /CURRENT bound document state/);
  assert.equal(observedModelText.includes("STALE_TOOL_OUTPUT"), false);
});

test("continuation rejects a run that did not stop at the turn limit", async () => {
  const persistence = memoryPersistence("user-1");
  const original = await persistence.appendMessage({
    threadId: "thread-1",
    ownerUserId: "user-1",
    role: "user",
    content: "Edit the document.",
  });
  const completed = await persistence.createRun({
    threadId: "thread-1",
    ownerUserId: "user-1",
    createdByUserId: "user-1",
    triggeringMessageId: original.id,
    status: "queued",
  });
  await persistence.updateRunStatus({
    runId: completed.id,
    ownerUserId: "user-1",
    status: "completed",
  });
  const execution = createAgentExecutionService(baseDeps(persistence, async () => softResult("completed", "Done.")));
  await assert.rejects(
    () => execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "Continue",
      continueFromRunId: completed.id,
    }),
    /cannot be continued/,
  );
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
        resultMessageId: null,
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

test("pre-model checkpoint/history throw terminalizes the run (not orphaned queued)", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.getLatestThreadContextCheckpoint = async () => {
    const err = new Error(
      'Failed query: select "agent_thread_context_checkpoint"...\nparams: x',
    );
    (err as Error & { cause: Error }).cause = Object.assign(
      new Error('relation "agent_thread_context_checkpoint" does not exist'),
      { code: "42P01" },
    );
    throw err;
  };

  const events: AgentEvent[] = [];
  const execution = createAgentExecutionService(
    baseDeps(persistence, async () => {
      throw new Error("model should not run");
    }),
  );

  const handle = await execution.start({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "rewrite intro",
    liveEvents: {
      emit(event) {
        events.push(event);
      },
    },
  });

  const result = await handle.result;
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_EXECUTION_FAILED");
  assert.equal(events.some((e) => e.type === "agent.failed"), true);
  assert.equal(events.some((e) => e.type === "agent.completed"), false);
});

test("run-manager safety net terminalizes when background result rejects", async () => {
  const persistence = memoryPersistence("user-1");
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<never>((_, reject) => {
    rejectResult = reject;
  });

  // Seed a durable queued run so the safety net can update it.
  const seeded = await persistence.createRun({
    threadId: "thread-1",
    ownerUserId: "user-1",
    createdByUserId: "user-1",
    triggeringMessageId: "msg-seed",
    baseDocumentVersionId: null,
    status: "queued",
  });

  const execution = {
    async start() {
      return {
        thread: stubThread("user-1"),
        userMessage: {
          id: "msg-1",
          threadId: "thread-1",
          role: "user" as const,
          content: "go",
          createdAt: now(),
        },
        run: seeded,
        result: resultPromise,
      };
    },
  };

  const events: Array<{ type: string }> = [];
  const runManager = createAgentRunManager({
    execution: execution as never,
    persistence,
    liveGraceMs: 5,
  });

  const started = await runManager.startRun({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "go",
  });
  const sub = runManager.subscribeEvents({
    runId: started.run.id,
    ownerUserId: "user-1",
    onEvent: (event) => {
      events.push({ type: event.type });
    },
  });
  assert.equal(sub.status, "ok");

  rejectResult(new Error("escaped before settle"));
  await runManager.waitForIdle();
  // Allow the async safety-net catch to finish.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const durable = await persistence.getRun({
    runId: seeded.id,
    ownerUserId: "user-1",
  });
  assert.equal(durable?.status, "failed");
  assert.equal(events.some((e) => e.type === "agent.failed"), true);
  if (sub.status === "ok") sub.unsubscribe();
});

test("duplicate cancel is idempotent and does not corrupt a failed run", async () => {
  const persistence = memoryPersistence("user-1");
  let resolveRun!: (value: {
    thread: AgentThread;
    userMessage: AgentMessage;
    run: AgentRun;
    assistantMessage: null;
  }) => void;
  const resultPromise = new Promise<{
    thread: AgentThread;
    userMessage: AgentMessage;
    run: AgentRun;
    assistantMessage: null;
  }>((resolve) => {
    resolveRun = resolve;
  });

  const run: AgentRun = {
    id: "cancel-run-1",
    threadId: "thread-1",
    triggeringMessageId: "msg-1",
        createdByUserId: "user-1",
        baseDocumentVersionId: null,
        resultMessageId: null,
    status: "running",
    createdAt: now(),
    startedAt: now(),
    completedAt: null,
    errorCode: null,
    errorMessage: null,
  };
  persistence.runs.set(run.id, run);

  const execution = {
    async start() {
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

  await runManager.startRun({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "go",
  });

  assert.equal(runManager.cancel({ runId: run.id, ownerUserId: "user-1" }), true);
  assert.equal(runManager.cancel({ runId: run.id, ownerUserId: "user-1" }), true);

  // Simulate settle as cancelled (what runExecution does on abort).
  await persistence.updateRunStatus({
    runId: run.id,
    ownerUserId: "user-1",
    status: "cancelled",
  });
  resolveRun({
    thread: stubThread("user-1"),
    userMessage: {
      id: "msg-1",
      threadId: "thread-1",
      role: "user",
      content: "go",
      createdAt: now(),
    },
    run: (await persistence.getRun({ runId: run.id, ownerUserId: "user-1" }))!,
    assistantMessage: null,
  });
  await runManager.waitForIdle();

  const durable = await persistence.getRun({
    runId: run.id,
    ownerUserId: "user-1",
  });
  assert.equal(durable?.status, "cancelled");

  // During liveGraceMs the hub is still tracked; cancel remains a harmless
  // idempotent true (abort already done). After grace, the entry is gone.
  assert.equal(runManager.cancel({ runId: run.id, ownerUserId: "user-1" }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runManager.cancel({ runId: run.id, ownerUserId: "user-1" }), false);

  // Cancel after failed must not corrupt durable terminal state.
  await persistence.updateRunStatus({
    runId: run.id,
    ownerUserId: "user-1",
    status: "failed",
    errorCode: "AGENT_EXECUTION_FAILED",
    errorMessage: "Agent execution failed",
  });
  assert.equal(runManager.cancel({ runId: run.id, ownerUserId: "user-1" }), false);
  const failed = await persistence.getRun({
    runId: run.id,
    ownerUserId: "user-1",
  });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorCode, "AGENT_EXECUTION_FAILED");
});
