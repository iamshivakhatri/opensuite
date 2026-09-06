import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  AutoApproveConfirmationGate,
  ToolRegistry,
  assistantOnlyResponse,
  createFakeTool,
  createScriptedAgentModel,
  delay,
  denyAllConfirmationGate,
  toolCallResponse,
  type AgentModel,
  type ModelRequest,
} from "@opensuite/agent-core";
import { createDbClient, schema } from "@opensuite/db";
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  AgentExecutionError,
  createAgentExecutionService,
  type AgentExecutionServiceDeps,
} from "../agent/execution.js";
import {
  AgentPersistenceError,
  createAgentPersistenceService,
  type AgentPersistenceService,
} from "../agent/persistence.js";
import {
  DocumentAccessError,
  type DocumentService,
  type ListedDocumentDto,
} from "../documents/service.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

type Db = ReturnType<typeof createDbClient>["db"];

async function seedUser(db: Db, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.user).values({
    id,
    name: label,
    email: `agent-exec-${label}-${id}@example.com`,
    emailVerified: true,
  });
  return id;
}

async function seedWorkspace(
  db: Db,
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
  db: Db,
  workspaceId: string,
  name = "brief.docx",
): Promise<{ documentId: string; versionId: string; version2Id: string }> {
  const [doc] = await db
    .insert(schema.document)
    .values({
      workspaceId,
      name,
      format: "docx",
    })
    .returning({ id: schema.document.id });
  assert.ok(doc);

  const [v1] = await db
    .insert(schema.documentVersion)
    .values({
      documentId: doc.id,
      versionNumber: 1,
      storageKey: `test/${doc.id}/v1`,
      sizeBytes: 10,
      source: "user",
    })
    .returning({ id: schema.documentVersion.id });
  assert.ok(v1);

  const [v2] = await db
    .insert(schema.documentVersion)
    .values({
      documentId: doc.id,
      versionNumber: 2,
      storageKey: `test/${doc.id}/v2`,
      sizeBytes: 20,
      source: "user",
      parentVersionId: v1.id,
    })
    .returning({ id: schema.documentVersion.id });
  assert.ok(v2);

  return { documentId: doc.id, versionId: v1.id, version2Id: v2.id };
}

function createOwnedDocumentResolver(db: Db): Pick<
  DocumentService,
  "getOwnedDocument" | "appendDocumentVersion"
> {
  return {
    async getOwnedDocument(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<ListedDocumentDto> {
      const [row] = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          versionId: schema.documentVersion.id,
          versionNumber: schema.documentVersion.versionNumber,
          sizeBytes: schema.documentVersion.sizeBytes,
          source: schema.documentVersion.source,
          versionCreatedAt: schema.documentVersion.createdAt,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .innerJoin(
          schema.documentVersion,
          eq(schema.documentVersion.documentId, schema.document.id),
        )
        .where(
          and(
            eq(schema.document.id, input.documentId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(desc(schema.documentVersion.versionNumber))
        .limit(1);

      if (!row) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      return {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        format: row.format,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        latestVersion: {
          id: row.versionId,
          versionNumber: row.versionNumber,
          sizeBytes: row.sizeBytes,
          source: row.source,
          createdAt: row.versionCreatedAt.toISOString(),
        },
      };
    },
    async appendDocumentVersion() {
      throw new Error(
        "appendDocumentVersion not implemented in agent execution test resolver",
      );
    },
  };
}

function createService(
  persistence: AgentPersistenceService,
  documents: Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">,
  overrides: Partial<AgentExecutionServiceDeps> & { model: AgentModel },
) {
  return createAgentExecutionService({
    persistence,
    documents,
    tools: overrides.tools ?? ToolRegistry.create([]),
    confirmation: overrides.confirmation,
    steering: overrides.steering,
    runtime: overrides.runtime,
    mutations: overrides.mutations,
    maxTurns: overrides.maxTurns,
    model: overrides.model,
  });
}

test(
  "agent execution: ownership, start transaction, context, success, tools, failure, cancel, confirmation",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const db = dbClient.db;
    const persistence = createAgentPersistenceService(db);
    const documents = createOwnedDocumentResolver(db);

    try {
      const aliceId = await seedUser(db, "alice");
      const bobId = await seedUser(db, "bob");
      const aliceWorkspaceId = await seedWorkspace(db, aliceId, "Alice WS");
      const bobWorkspaceId = await seedWorkspace(db, bobId, "Bob WS");
      const aliceDoc = await seedDocument(db, aliceWorkspaceId);
      const bobDoc = await seedDocument(db, bobWorkspaceId, "bob.docx");

      const aliceThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
        title: "Rewrite",
      });
      const bobThread = await persistence.createThread({
        workspaceId: bobWorkspaceId,
        ownerUserId: bobId,
        documentId: bobDoc.documentId,
        createdByUserId: bobId,
        title: "Bob thread",
      });
      const workspaceThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        createdByUserId: aliceId,
        title: "Workspace chat",
      });

      // --- OWNERSHIP ---
      const ownershipService = createService(persistence, documents, {
        model: createScriptedAgentModel([assistantOnlyResponse("nope")]),
      });
      await assert.rejects(
        () =>
          ownershipService.execute({
            userId: bobId,
            threadId: aliceThread.id,
            instruction: "Hack alice",
          }),
        (error: unknown) =>
          error instanceof AgentExecutionError &&
          error.code === "THREAD_NOT_FOUND",
      );
      await assert.rejects(
        () =>
          ownershipService.execute({
            userId: aliceId,
            threadId: bobThread.id,
            instruction: "Hack bob",
          }),
        (error: unknown) =>
          error instanceof AgentExecutionError &&
          error.code === "THREAD_NOT_FOUND",
      );

      // --- START TRANSACTION + DOCUMENT REF + SIMPLE SUCCESS ---
      let capturedTurns: Array<{ role: string; content: string }> = [];
      const successService = createService(persistence, documents, {
        model: createScriptedAgentModel([
          (request) => {
            capturedTurns = request.messages
              .filter(
                (message): message is Extract<
                  ModelRequest["messages"][number],
                  { role: "user" | "assistant" }
                > =>
                  message.role === "user" || message.role === "assistant",
              )
              .map((message) => ({
                role: message.role,
                content: message.content,
              }));
            return assistantOnlyResponse("Revised intro ready.");
          },
        ]),
      });

      const priorUser = await persistence.appendMessage({
        threadId: aliceThread.id,
        ownerUserId: aliceId,
        role: "user",
        content: "Earlier ask",
      });
      const priorAssistant = await persistence.appendMessage({
        threadId: aliceThread.id,
        ownerUserId: aliceId,
        role: "assistant",
        content: "Earlier answer",
      });

      const success = await successService.execute({
        userId: aliceId,
        threadId: aliceThread.id,
        instruction: "Rewrite the intro",
      });

      assert.equal(success.userMessage.role, "user");
      assert.equal(success.userMessage.content, "Rewrite the intro");
      assert.equal(success.run.triggeringMessageId, success.userMessage.id);
      assert.equal(success.run.status, "completed");
      assert.equal(success.run.baseDocumentVersionId, aliceDoc.version2Id);
      assert.ok(success.run.completedAt);
      assert.equal(success.assistantMessage?.role, "assistant");
      assert.equal(success.assistantMessage?.content, "Revised intro ready.");
      assert.equal(success.result.status, "completed");

      assert.deepEqual(capturedTurns, [
        { role: "user", content: priorUser.content },
        { role: "assistant", content: priorAssistant.content },
        { role: "user", content: "Rewrite the intro" },
      ]);
      assert.equal(
        capturedTurns.filter((m) => m.content === "Rewrite the intro").length,
        1,
      );

      // Document-scoped run received latest version (v2), not v1.
      // primaryDocument is on AgentRequest — inspect via a tool-bearing run below.
      const docProbeMessages: string[] = [];
      const docProbe = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "t1", name: "document.inspect", input: { note: "x" } },
          ]),
          assistantOnlyResponse("inspected"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "document.inspect",
            async execute(_input, ctx) {
              docProbeMessages.push(
                JSON.stringify(ctx.primaryDocument ?? null),
              );
              return { summary: "ok", format: "docx" };
            },
          }),
        ]),
      });
      await docProbe.execute({
        userId: aliceId,
        threadId: aliceThread.id,
        instruction: "Inspect doc",
      });
      assert.deepEqual(JSON.parse(docProbeMessages[0]!), {
        documentId: aliceDoc.documentId,
        versionId: aliceDoc.version2Id,
        format: "docx",
      });

      const [persistedRun] = await db
        .select({
          baseDocumentVersionId: schema.agentRun.baseDocumentVersionId,
        })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.id, success.run.id))
        .limit(1);
      assert.equal(persistedRun?.baseDocumentVersionId, aliceDoc.version2Id);

      // Workspace-scoped thread → no primary document.
      const wsProbe: Array<unknown> = [];
      const wsService = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "t1", name: "noop", input: {} },
          ]),
          assistantOnlyResponse("done"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "noop",
            async execute(_input, ctx) {
              wsProbe.push(ctx.primaryDocument ?? null);
              return true;
            },
          }),
        ]),
      });
      await wsService.execute({
        userId: aliceId,
        threadId: workspaceThread.id,
        instruction: "Workspace ask",
      });
      assert.equal(wsProbe[0], null);

      const wsRun = await persistence.getLatestRunForThread({
        threadId: workspaceThread.id,
        ownerUserId: aliceId,
      });
      assert.equal(wsRun?.baseDocumentVersionId ?? null, null);

      // --- SEQUENTIAL TOOLS ---
      const seqThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const sequential = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "a", name: "tool.a", input: { n: 1 } },
            { id: "b", name: "tool.b", input: { n: 2 } },
          ]),
          assistantOnlyResponse("both done"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "tool.a",
            async execute(input) {
              return { summary: "a", input };
            },
          }),
          createFakeTool({
            name: "tool.b",
            async execute(input) {
              return { summary: "b", input };
            },
          }),
        ]),
      });
      const seqResult = await sequential.execute({
        userId: aliceId,
        threadId: seqThread.id,
        instruction: "Run both",
      });
      assert.equal(seqResult.run.status, "completed");
      assert.equal(seqResult.steps.length, 2);
      assert.deepEqual(
        seqResult.steps.map((step) => ({
          sequence: step.sequence,
          name: step.name,
          status: step.status,
        })),
        [
          { sequence: 0, name: "tool.a", status: "completed" },
          { sequence: 1, name: "tool.b", status: "completed" },
        ],
      );

      // --- PARALLEL TOOLS (completion order ≠ sequence) ---
      const parallelThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const parallel = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "slow", name: "tool.slow", input: {} },
            { id: "fast", name: "tool.fast", input: {} },
          ]),
          assistantOnlyResponse("parallel done"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "tool.slow",
            executionMode: "parallel-safe",
            async execute() {
              await delay(40);
              return { summary: "slow" };
            },
          }),
          createFakeTool({
            name: "tool.fast",
            executionMode: "parallel-safe",
            async execute() {
              return { summary: "fast" };
            },
          }),
        ]),
      });
      const parallelResult = await parallel.execute({
        userId: aliceId,
        threadId: parallelThread.id,
        instruction: "Parallel",
      });
      assert.deepEqual(
        parallelResult.steps.map((step) => ({
          sequence: step.sequence,
          name: step.name,
          status: step.status,
        })),
        [
          { sequence: 0, name: "tool.slow", status: "completed" },
          { sequence: 1, name: "tool.fast", status: "completed" },
        ],
      );

      // --- PARTIAL FAILURE ---
      const partialThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const partial = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "ok", name: "tool.ok", input: {} },
            { id: "bad", name: "tool.bad", input: {} },
            { id: "ok2", name: "tool.ok2", input: {} },
          ]),
          assistantOnlyResponse("partial success"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "tool.ok",
            async execute() {
              return { summary: "ok" };
            },
          }),
          createFakeTool({
            name: "tool.bad",
            async execute() {
              throw new Error("boom");
            },
          }),
          createFakeTool({
            name: "tool.ok2",
            async execute() {
              return { summary: "ok2" };
            },
          }),
        ]),
      });
      const partialResult = await partial.execute({
        userId: aliceId,
        threadId: partialThread.id,
        instruction: "Partial",
      });
      assert.equal(partialResult.run.status, "completed");
      assert.equal(partialResult.assistantMessage?.content, "partial success");
      assert.deepEqual(
        partialResult.steps.map((step) => ({
          name: step.name,
          status: step.status,
        })),
        [
          { name: "tool.ok", status: "completed" },
          { name: "tool.bad", status: "failed" },
          { name: "tool.ok2", status: "completed" },
        ],
      );

      // --- MODEL / RUNNER FAILURE ---
      const failThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const failing = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [{ id: "1", name: "tool.ok", input: {} }]),
          () => {
            throw new Error("model exploded");
          },
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "tool.ok",
            async execute() {
              return { summary: "kept" };
            },
          }),
        ]),
      });
      const failResult = await failing.execute({
        userId: aliceId,
        threadId: failThread.id,
        instruction: "Will fail",
      });
      assert.equal(failResult.run.status, "failed");
      assert.equal(failResult.assistantMessage, null);
      assert.equal(failResult.run.errorCode, "MODEL_FAILURE");
      assert.ok(failResult.run.completedAt);
      assert.equal(failResult.steps.length, 1);
      assert.equal(failResult.steps[0]?.status, "completed");
      const failMessages = await persistence.listMessagesForThread({
        threadId: failThread.id,
        ownerUserId: aliceId,
      });
      assert.equal(
        failMessages.filter((message) => message.role === "assistant").length,
        0,
      );

      // --- CANCELLATION ---
      const cancelThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const controller = new AbortController();
      const cancelling = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [{ id: "1", name: "tool.ok", input: {} }]),
          async () => {
            controller.abort();
            throw new Error("aborted");
          },
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "tool.ok",
            async execute() {
              return { summary: "before cancel" };
            },
          }),
        ]),
      });
      const cancelResult = await cancelling.execute({
        userId: aliceId,
        threadId: cancelThread.id,
        instruction: "Cancel me",
        signal: controller.signal,
      });
      assert.equal(cancelResult.run.status, "cancelled");
      assert.equal(cancelResult.assistantMessage, null);
      assert.ok(cancelResult.run.completedAt);
      assert.equal(cancelResult.steps[0]?.status, "completed");

      // --- CONFIRMATION approve ---
      const confirmThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      let destructiveExecuted = false;
      const approveService = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "d1", name: "slides.delete_slide", input: { index: 0 } },
          ]),
          assistantOnlyResponse("deleted"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "slides.delete_slide",
            risk: "destructive",
            async execute() {
              destructiveExecuted = true;
              return { summary: "deleted" };
            },
          }),
        ]),
        confirmation: new AutoApproveConfirmationGate(),
      });
      const approveResult = await approveService.execute({
        userId: aliceId,
        threadId: confirmThread.id,
        instruction: "Delete slide",
      });
      assert.equal(destructiveExecuted, true);
      assert.equal(approveResult.run.status, "completed");
      assert.ok(
        approveResult.steps.some(
          (step) =>
            step.kind === "confirmation" && step.status === "completed",
        ),
      );
      assert.ok(
        approveResult.steps.some(
          (step) =>
            step.kind === "tool" &&
            step.name === "slides.delete_slide" &&
            step.status === "completed",
        ),
      );

      // --- CONFIRMATION deny / no gate ---
      const denyThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      let deniedExecuted = false;
      const denyService = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "d1", name: "slides.delete_slide", input: {} },
          ]),
          assistantOnlyResponse("skipped"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "slides.delete_slide",
            risk: "destructive",
            async execute() {
              deniedExecuted = true;
              return true;
            },
          }),
        ]),
        confirmation: denyAllConfirmationGate,
      });
      const denyResult = await denyService.execute({
        userId: aliceId,
        threadId: denyThread.id,
        instruction: "Delete denied",
      });
      assert.equal(deniedExecuted, false);
      assert.equal(denyResult.run.status, "completed");
      assert.ok(
        denyResult.steps.some(
          (step) => step.kind === "confirmation" && step.status === "failed",
        ),
      );

      let noGateExecuted = false;
      const noGateThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const noGateService = createService(persistence, documents, {
        model: createScriptedAgentModel([
          toolCallResponse("", [
            { id: "d1", name: "slides.delete_slide", input: {} },
          ]),
          assistantOnlyResponse("still skipped"),
        ]),
        tools: ToolRegistry.create([
          createFakeTool({
            name: "slides.delete_slide",
            risk: "destructive",
            async execute() {
              noGateExecuted = true;
              return true;
            },
          }),
        ]),
        // no confirmation → agent-core default deny
      });
      await noGateService.execute({
        userId: aliceId,
        threadId: noGateThread.id,
        instruction: "Delete no gate",
      });
      assert.equal(noGateExecuted, false);

      // --- START TRANSACTION ROLLBACK ---
      const rollbackThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      const before = await persistence.listMessagesForThread({
        threadId: rollbackThread.id,
        ownerUserId: aliceId,
      });
      const flakyPersistence: AgentPersistenceService = {
        ...persistence,
        async createRun(input, tx) {
          await persistence.createRun(input, tx);
          throw new Error("forced createRun failure");
        },
      };
      const rollbackService = createService(flakyPersistence, documents, {
        model: createScriptedAgentModel([assistantOnlyResponse("unused")]),
      });
      await assert.rejects(
        () =>
          rollbackService.execute({
            userId: aliceId,
            threadId: rollbackThread.id,
            instruction: "Should roll back",
          }),
        (error: unknown) =>
          error instanceof AgentExecutionError &&
          error.code === "AGENT_PERSISTENCE_FAILED",
      );
      const after = await persistence.listMessagesForThread({
        threadId: rollbackThread.id,
        ownerUserId: aliceId,
      });
      assert.equal(after.length, before.length);

      // --- FINAL COMPLETION CONSISTENCY (assistant + completed atomic) ---
      const finalThread = await persistence.createThread({
        workspaceId: aliceWorkspaceId,
        ownerUserId: aliceId,
        documentId: aliceDoc.documentId,
        createdByUserId: aliceId,
      });
      let finalizeCalls = 0;
      const flakyFinalize: AgentPersistenceService = {
        ...persistence,
        async appendMessage(input, tx) {
          if (input.role === "assistant") {
            finalizeCalls += 1;
            if (finalizeCalls === 1) {
              throw new AgentPersistenceError(
                "THREAD_NOT_FOUND",
                "forced finalize failure",
              );
            }
          }
          return persistence.appendMessage(input, tx);
        },
      };
      const finalizeService = createService(flakyFinalize, documents, {
        model: createScriptedAgentModel([
          assistantOnlyResponse("should not stick"),
        ]),
      });
      await assert.rejects(
        () =>
          finalizeService.execute({
            userId: aliceId,
            threadId: finalThread.id,
            instruction: "Finalize fail",
          }),
        (error: unknown) =>
          error instanceof AgentExecutionError &&
          error.code === "AGENT_PERSISTENCE_FAILED",
      );
      const finalMessages = await persistence.listMessagesForThread({
        threadId: finalThread.id,
        ownerUserId: aliceId,
      });
      assert.equal(
        finalMessages.filter((message) => message.role === "assistant").length,
        0,
      );
      const runs = await db
        .select({
          status: schema.agentRun.status,
          errorCode: schema.agentRun.errorCode,
        })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.threadId, finalThread.id));
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "failed");
      assert.equal(runs[0]?.errorCode, "AGENT_PERSISTENCE_FAILED");
    } finally {
      await dbClient.close();
    }
  },
);
