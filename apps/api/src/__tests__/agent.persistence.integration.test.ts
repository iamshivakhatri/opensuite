import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient, schema } from "@opensuite/db";

import {
  AgentPersistenceError,
  createAgentPersistenceService,
} from "../agent/persistence.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

async function seedUser(
  db: ReturnType<typeof createDbClient>["db"],
  label: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.user).values({
    id,
    name: label,
    email: `agent-${label}-${id}@example.com`,
    emailVerified: true,
  });
  return id;
}

async function seedWorkspace(
  db: ReturnType<typeof createDbClient>["db"],
  ownerUserId: string,
  name: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.workspace)
    .values({ ownerUserId, name })
    .returning({ id: schema.workspace.id });
  assert.ok(row);
  return row.id;
}

async function seedDocument(
  db: ReturnType<typeof createDbClient>["db"],
  workspaceId: string,
  name = "brief.docx",
): Promise<string> {
  const [row] = await db
    .insert(schema.document)
    .values({
      workspaceId,
      name,
      format: "docx",
    })
    .returning({ id: schema.document.id });
  assert.ok(row);
  return row.id;
}

test(
  "agent persistence: threads, messages, runs, steps, ownership, and invariants",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const db = dbClient.db;
    const agents = createAgentPersistenceService(db);

    try {
      const aliceId = await seedUser(db, "alice");
      const bobId = await seedUser(db, "bob");
      const aliceWorkspaceId = await seedWorkspace(db, aliceId, "Alice WS");
      const bobWorkspaceId = await seedWorkspace(db, bobId, "Bob WS");
      const aliceDocId = await seedDocument(db, aliceWorkspaceId);
      const bobDocId = await seedDocument(db, bobWorkspaceId, "bob.docx");

      // --- THREADS ---
      const workspaceThread = await agents.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        createdByUserId: aliceId,
        title: "Compare files",
      });
      assert.equal(workspaceThread.documentId, null);
      assert.equal(workspaceThread.workspaceId, aliceWorkspaceId);
      assert.equal(workspaceThread.archivedAt, null);

      const documentThread = await agents.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDocId,
        createdByUserId: aliceId,
        title: "Rewrite this",
      });
      assert.equal(documentThread.documentId, aliceDocId);

      await assert.rejects(
        () =>
          agents.createThread({
            workspaceId: aliceWorkspaceId,
            ownerUserId: aliceId,
            documentId: bobDocId,
            createdByUserId: aliceId,
          }),
        (error: unknown) =>
          error instanceof AgentPersistenceError &&
          error.code === "DOCUMENT_WORKSPACE_MISMATCH",
      );

      assert.equal(
        await agents.getOwnedThread({
          threadId: workspaceThread.id,
          ownerUserId: bobId,
        }),
        null,
      );

      const archived = await agents.archiveThread({
        threadId: workspaceThread.id,
        ownerUserId: aliceId,
      });
      assert.ok(archived.archivedAt);

      const activeOnly = await agents.listThreadsForWorkspace({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
      });
      assert.equal(
        activeOnly.some((thread) => thread.id === workspaceThread.id),
        false,
      );
      assert.equal(
        activeOnly.some((thread) => thread.id === documentThread.id),
        true,
      );

      const withArchived = await agents.listThreadsForWorkspace({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        includeArchived: true,
      });
      assert.equal(
        withArchived.some((thread) => thread.id === workspaceThread.id),
        true,
      );

      const stillOwned = await agents.getOwnedThread({
        threadId: workspaceThread.id,
        ownerUserId: aliceId,
      });
      assert.ok(stillOwned?.archivedAt);

      // --- MESSAGES ---
      const userMessage = await agents.appendMessage({
        threadId: documentThread.id,
        ownerUserId: aliceId,
        role: "user",
        content: "Rewrite the intro",
      });
      const assistantMessage = await agents.appendMessage({
        threadId: documentThread.id,
        ownerUserId: aliceId,
        role: "assistant",
        content: "Here is a revised intro.",
      });
      assert.equal(userMessage.role, "user");
      assert.equal(assistantMessage.role, "assistant");

      const messages = await agents.listMessagesForThread({
        threadId: documentThread.id,
        ownerUserId: aliceId,
      });
      assert.deepEqual(
        messages.map((message) => message.id),
        [userMessage.id, assistantMessage.id],
      );

      await assert.rejects(
        () =>
          agents.appendMessage({
            threadId: documentThread.id,
            ownerUserId: bobId,
            role: "user",
            content: "Nope",
          }),
        (error: unknown) =>
          error instanceof AgentPersistenceError &&
          error.code === "THREAD_NOT_FOUND",
      );

      // --- RUNS ---
      const run = await agents.createRun({
        threadId: documentThread.id,
        ownerUserId: aliceId,
        createdByUserId: aliceId,
        triggeringMessageId: userMessage.id,
      });
      assert.equal(run.status, "queued");
      assert.equal(run.triggeringMessageId, userMessage.id);
      assert.equal(run.startedAt, null);

      let current = await agents.updateRunStatus({
        runId: run.id,
        ownerUserId: aliceId,
        status: "planning",
      });
      assert.equal(current.status, "planning");
      assert.ok(current.startedAt);

      current = await agents.updateRunStatus({
        runId: run.id,
        ownerUserId: aliceId,
        status: "running",
      });
      current = await agents.updateRunStatus({
        runId: run.id,
        ownerUserId: aliceId,
        status: "waiting_for_confirmation",
      });
      current = await agents.updateRunStatus({
        runId: run.id,
        ownerUserId: aliceId,
        status: "running",
      });
      current = await agents.updateRunStatus({
        runId: run.id,
        ownerUserId: aliceId,
        status: "completed",
      });
      assert.equal(current.status, "completed");
      assert.ok(current.completedAt);

      await assert.rejects(
        () =>
          agents.updateRunStatus({
            runId: run.id,
            ownerUserId: aliceId,
            status: "running",
          }),
        (error: unknown) =>
          error instanceof AgentPersistenceError &&
          error.code === "INVALID_RUN_STATUS_TRANSITION",
      );

      const failedRun = await agents.createRun({
        threadId: documentThread.id,
        ownerUserId: aliceId,
        createdByUserId: aliceId,
      });
      const failed = await agents.updateRunStatus({
        runId: failedRun.id,
        ownerUserId: aliceId,
        status: "failed",
        errorCode: "TOOL_ERROR",
        errorMessage: "Inspect failed",
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "TOOL_ERROR");
      assert.equal(failed.errorMessage, "Inspect failed");
      assert.ok(failed.completedAt);

      assert.equal(
        await agents.getRun({ runId: run.id, ownerUserId: bobId }),
        null,
      );

      // --- STEPS ---
      const stepRun = await agents.createRun({
        threadId: documentThread.id,
        ownerUserId: aliceId,
        createdByUserId: aliceId,
      });

      const step1 = await agents.appendStep({
        runId: stepRun.id,
        ownerUserId: aliceId,
        sequence: 0,
        kind: "plan",
        name: "Plan rewrite",
        input: { goal: "rewrite intro" },
      });
      const step2 = await agents.appendStep({
        runId: stepRun.id,
        ownerUserId: aliceId,
        sequence: 1,
        kind: "inspect",
        name: "Inspect document",
      });
      assert.deepEqual(step1.input, { goal: "rewrite intro" });

      await assert.rejects(
        () =>
          agents.appendStep({
            runId: stepRun.id,
            ownerUserId: aliceId,
            sequence: 0,
            kind: "tool",
            name: "Duplicate",
          }),
        (error: unknown) =>
          error instanceof AgentPersistenceError &&
          error.code === "STEP_SEQUENCE_CONFLICT",
      );

      const completedStep = await agents.updateStepStatus({
        stepId: step1.id,
        ownerUserId: aliceId,
        status: "running",
      });
      assert.equal(completedStep.status, "running");
      assert.ok(completedStep.startedAt);

      const finished = await agents.updateStepStatus({
        stepId: step1.id,
        ownerUserId: aliceId,
        status: "completed",
        summary: "Plan ready",
        output: { ops: 2 },
      });
      assert.equal(finished.status, "completed");
      assert.equal(finished.summary, "Plan ready");
      assert.deepEqual(finished.output, { ops: 2 });
      assert.ok(finished.completedAt);

      const steps = await agents.listStepsForRun({
        runId: stepRun.id,
        ownerUserId: aliceId,
      });
      assert.deepEqual(
        steps.map((step) => step.sequence),
        [0, 1],
      );
      assert.equal(steps[0]!.id, step1.id);
      assert.equal(steps[1]!.id, step2.id);

      // Atomic append message + create run
      const atomic = await agents.withTransaction(async (tx) => {
        const message = await agents.appendMessage(
          {
            threadId: documentThread.id,
            ownerUserId: aliceId,
            role: "user",
            content: "Also fix the conclusion",
          },
          tx,
        );
        const nestedRun = await agents.createRun(
          {
            threadId: documentThread.id,
            ownerUserId: aliceId,
            createdByUserId: aliceId,
            triggeringMessageId: message.id,
          },
          tx,
        );
        return { message, nestedRun };
      });
      assert.equal(atomic.nestedRun.triggeringMessageId, atomic.message.id);

      // Bob cannot list Alice workspace threads
      await assert.rejects(
        () =>
          agents.listThreadsForWorkspace({
            workspaceId: aliceWorkspaceId,
            ownerUserId: bobId,
          }),
        (error: unknown) =>
          error instanceof AgentPersistenceError &&
          error.code === "WORKSPACE_NOT_FOUND",
      );
    } finally {
      await dbClient.close();
    }
  },
);
