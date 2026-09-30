import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutionLeaseService } from "./execution-lease.js";
import type { AgentPersistenceService, AgentRun } from "./persistence.js";
import { createAgentRunManager } from "./run-manager.js";

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    threadId: "thread-1",
    triggeringMessageId: null,
    createdByUserId: "user-1",
    baseDocumentVersionId: null,
    resultMessageId: null,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function createManager(persistence: Partial<AgentPersistenceService>, execution: unknown = {}) {
  return createAgentRunManager({
    execution: execution as never,
    persistence: persistence as AgentPersistenceService,
  });
}

test("repairAbandonedRun marks non-live run failed and releases orphan lease", async () => {
  const updated = baseRun({
    status: "failed",
    errorCode: "RUN_ABANDONED",
    errorMessage: "Agent run is no longer live (process exit or restart)",
    completedAt: "2026-01-01T00:01:00.000Z",
  });
  let releasedUser: string | null = null;
  const updates: unknown[] = [];

  const manager = createManager({
    updateRunStatus: async (input) => {
      updates.push(input);
      return updated;
    },
  });

  const lease: Pick<AgentExecutionLeaseService, "releaseUser"> = {
    releaseUser: async (userId) => {
      releasedUser = userId;
      return true;
    },
  };

  const durable = await manager.repairAbandonedRun({
    run: baseRun(),
    ownerUserId: "user-1",
    lease: lease as AgentExecutionLeaseService,
  });

  assert.deepEqual(updates, [
    {
      runId: "run-1",
      ownerUserId: "user-1",
      status: "failed",
      errorCode: "RUN_ABANDONED",
      errorMessage: "Agent run is no longer live (process exit or restart)",
    },
  ]);
  assert.equal(releasedUser, "user-1");
  assert.equal(durable, updated);
});

test("repairAbandonedRun skips lease release when another run is live for owner", async () => {
  let released = false;
  const hang = new Promise<never>(() => undefined);

  const manager = createManager(
    {
      updateRunStatus: async () =>
        baseRun({
          id: "orphan-run",
          status: "failed",
          errorCode: "RUN_ABANDONED",
          errorMessage: "Agent run is no longer live (process exit or restart)",
        }),
    },
    {
      start: async () => ({
        run: baseRun({ id: "live-run" }),
        userMessage: {
          id: "msg-1",
          threadId: "thread-1",
          role: "user" as const,
          content: "go",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        result: hang,
        getWorkingDocument: () => null,
      }),
    },
  );

  await manager.startRun({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "go",
  });
  assert.equal(manager.hasLiveForOwner("user-1"), true);

  const lease: Pick<AgentExecutionLeaseService, "releaseUser"> = {
    releaseUser: async () => {
      released = true;
      return true;
    },
  };

  await manager.repairAbandonedRun({
    run: baseRun({ id: "orphan-run" }),
    ownerUserId: "user-1",
    lease: lease as AgentExecutionLeaseService,
  });

  assert.equal(released, false);
});

test("repairAbandonedRun falls back to refreshed run when status update fails", async () => {
  const refreshed = baseRun({
    status: "failed",
    errorCode: "RUN_ABANDONED",
    errorMessage: "Agent run is no longer live (process exit or restart)",
  });
  const manager = createManager({
    updateRunStatus: async () => {
      throw new Error("db write failed");
    },
    getRun: async () => refreshed,
  });

  const durable = await manager.repairAbandonedRun({
    run: baseRun(),
    ownerUserId: "user-1",
  });

  assert.equal(durable, refreshed);
});

test("repairAbandonedRun keeps original run when update and refresh both fail", async () => {
  const original = baseRun();
  const manager = createManager({
    updateRunStatus: async () => {
      throw new Error("db write failed");
    },
    getRun: async () => null,
  });

  const durable = await manager.repairAbandonedRun({
    run: original,
    ownerUserId: "user-1",
  });

  assert.equal(durable, original);
});
