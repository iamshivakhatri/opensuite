import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent, type RunAgentResult, type RunModelResult, type V3Model } from "@opensuite/agent-core-v3";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import sharp from "sharp";
import { bindDocxDocument, buildMinimalDocx, createNapiDocxEngineBinding, inspectDocxStyleSnapshot } from "@opensuite/engine-client";
import type { AgentRunReport } from "./agent-run-report.js";

import {
  createAgentExecutionService,
  type AgentEvent,
  type AgentExecutionServiceDeps,
} from "./execution.js";
import { boundedStopMessage, describeRunFailure } from "./run-settlement.js";
import { loadHistory } from "./agent-context.js";
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

test("new human run loads a prior final reply and keeps an empty-result run as a terminal status", async () => {
  const persistence = memoryPersistence("user-1");
  const first = await persistence.appendMessage({ threadId: "thread-1", ownerUserId: "user-1", role: "user", content: "Create a report" });
  const firstRun = await persistence.createRun({ threadId: "thread-1", ownerUserId: "user-1", createdByUserId: "user-1", triggeringMessageId: first.id, baseDocumentVersionId: null, status: "running" });
  const reply = await persistence.appendMessage({ threadId: "thread-1", ownerUserId: "user-1", role: "assistant", content: "Report created" });
  await persistence.updateRunStatus({ runId: firstRun.id, ownerUserId: "user-1", status: "completed", resultMessageId: reply.id });
  await persistence.appendSteps({ runId: firstRun.id, ownerUserId: "user-1", steps: [{ sequence: 0, kind: "tool", status: "completed", name: "document.create_table", summary: "Completed" }] });
  const second = await persistence.appendMessage({ threadId: "thread-1", ownerUserId: "user-1", role: "user", content: "Update it" });
  const secondRun = await persistence.createRun({ threadId: "thread-1", ownerUserId: "user-1", createdByUserId: "user-1", triggeringMessageId: second.id, baseDocumentVersionId: null, status: "running" });
  await persistence.updateRunStatus({ runId: secondRun.id, ownerUserId: "user-1", status: "failed", errorMessage: "Stopped early" });
  const history = await loadHistory({ persistence, threadId: "thread-1", ownerUserId: "user-1", excludeMessageId: "next-message" });
  assert.deepEqual(history.priorMessages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.match(history.priorMessages[1]!.content, /document.create_table[\s\S]*Report created/);
  assert.match(history.priorMessages[2]!.content, /status: failed[\s\S]*Stopped early/);
  assert.equal(history.historyLoad.assistantFinalMessagesLoaded, 1);
});

test("API full trace records retrieval, saved version, validation and durable settlement; setup errors and cancellation also settle", async () => {
  const previousMode = process.env.AGENT_RUN_TRACE;
  const previousDir = process.env.AGENT_RUN_TRACE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "opensuite-api-trace-"));
  process.env.AGENT_RUN_TRACE = "full";
  process.env.AGENT_RUN_TRACE_DIR = dir;
  try {
    const persistence = memoryPersistence("user-1");
    const binding = await createNapiDocxEngineBinding();
    const versions = new Map([["v1", Buffer.from(buildMinimalDocx(["Before"]))]]);
    let versionId = "v1";
    let modelTurn = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      ...(modelTurn++ === 0 ? [{ type: "tool-call", toolCallId: "replace-1", toolName: "document_replace_text", input: JSON.stringify({ target: { text: "Before" }, expectedCurrentText: "Before", replacement: "After" }) }]
        : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done" }, { type: "text-end", id: "t" }]),
      { type: "finish", finishReason: { unified: modelTurn === 1 ? "tool-calls" : "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
    ] as never[] }) }) });
    const deps = baseDeps(persistence, (input) => runAgent({ ...input, model }), undefined, 128_000);
    const document = () => ({ id: "doc-1", name: "Report.docx", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } });
    const execution = createAgentExecutionService({ ...deps, docxBinding: binding,
      documents: { ...deps.documents, listInWorkspace: async () => [document()] as never,
        getOwnedDocument: async () => document() as never,
        readExactVersionBytes: async (input) => versions.get(input.versionId)!,
        appendDocumentVersion: async (input) => { versionId = "v2"; versions.set(versionId, Buffer.from(input.bytes)); return { version: { id: versionId, versionNumber: 2 } } as never; },
      },
    });
    const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Update this document: replace Before with After" })).result;
    assert.equal(result.run.status, "completed");
    assert.equal(versionId, "v2");
    assert.equal(readdirSync(dir).length, 1);
    const content = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    for (const expected of ["Artifact Metadata", "Document Evidence / Injected Context", "Before", "After", "Turn 1 — Request", "Raw", "Validation", "Run Report", "Settlement", "v1", "v2"]) assert.ok(content.includes(expected === "Raw" ? "rawResult" : expected), expected);
    assert.match(content, /"status": "completed"/);
    assert.match(content, /"outcome": "success"/);

    persistence.getLatestThreadContextCheckpoint = async () => { throw new Error("setup failed"); };
    const failure = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "test failure" })).result;
    assert.equal(failure.run.status, "failed");
    persistence.getLatestThreadContextCheckpoint = async () => null;
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const cancellation = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "test cancellation", signal: controller.signal })).result;
    assert.equal(cancellation.run.status, "cancelled");
    const files = readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
    assert.equal(files.length, 3);
    assert.ok(files.some((file) => file.includes("setup failed") && file.includes('"status": "failed"') && file.includes("Settlement")));
    assert.ok(files.some((file) => file.includes('"status": "cancelled"') && file.includes("Settlement")));

    process.env.AGENT_RUN_TRACE = "off";
    await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "disabled test", signal: controller.signal })).result;
    assert.equal(readdirSync(dir).length, 3);
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_RUN_TRACE; else process.env.AGENT_RUN_TRACE = previousMode;
    if (previousDir === undefined) delete process.env.AGENT_RUN_TRACE_DIR; else process.env.AGENT_RUN_TRACE_DIR = previousDir;
    rmSync(dir, { recursive: true });
  }
});

for (const tracing of [false, true]) {
  test(`DIRECT view refreshes working bytes once per edited turn; tracing=${tracing}`, async (t) => {
    const previousMode = process.env.AGENT_RUN_TRACE;
    const previousDir = process.env.AGENT_RUN_TRACE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "opensuite-direct-state-"));
    process.env.AGENT_RUN_TRACE = tracing ? "full" : "off";
    process.env.AGENT_RUN_TRACE_DIR = dir;
    try {
      const realBinding = await createNapiDocxEngineBinding();
      let completeLoads = 0;
      const binding = { ...realBinding, inspectDocx: async (...args: Parameters<typeof realBinding.inspectDocx>) => {
        if (args[1].focus.kind === "body_blocks" && args[1].focus.limit === 100) completeLoads++;
        return realBinding.inspectDocx(...args);
      } };
      const original = Buffer.from(buildMinimalDocx(["Old title", "First", "Second", "Third"]));
      let saved = original;
      let versionId = "v1";
      let appends = 0;
      let reads = 0;
      let initialReads = 0;
      let turn = 0;
      const snapshots: string[] = [];
      const persistence = memoryPersistence("user-1");
      const model = new MockLanguageModelV4({ doStream: async (options) => {
        const current = turn++;
        assert.equal(appends, 0, "refresh must not persist a version");
        if (!current) initialReads = reads;
        assert.equal(reads, initialReads, "refresh must not read storage");
        assert.equal(completeLoads, [1, 2, 2, 3][current], "one regeneration per edited turn");
        const views = options.prompt.filter((message) => message.role === "user" && JSON.stringify(message).includes("COMPLETE CURRENT DOCUMENT CONTENT"));
        assert.equal(views.length, 1);
        assert.equal(options.prompt.indexOf(views[0]!), 1, "fixed position after the system message");
        const snapshot = JSON.stringify(views[0]);
        snapshots.push(snapshot);
        if (!current) {
          assert.match(snapshot, /First/);
          assert.doesNotMatch(snapshot, /working revision/);
        } else {
          for (const text of ["One", "Two", "Three"]) assert.ok(snapshot.includes(text));
          for (const text of ["First", "Second", "Third"]) assert.ok(!snapshot.includes(text));
          assert.match(snapshot, new RegExp(`working revision ${current === 3 ? 4 : 3}`));
        }
        if (current === 2) assert.equal(snapshot, snapshots[1], "failed mutation and reads reuse the snapshot");
        if (current === 3) assert.match(snapshot, /Inserted/);
        const calls = [
          [{ name: "document_inspect", input: { kind: "body_blocks" } },
            ...[["First", "One"], ["Second", "Two"], ["Third", "Three"]].map(([text, replacement]) => ({ name: "document_replace_text", input: { target: { text }, expectedCurrentText: text, replacement } }))],
          [{ name: "document_insert_paragraphs", input: { texts: ["Stale"], placement: { kind: "before", handle: "b0" } } },
            { name: "document_find", input: { text: "One" } }],
          [{ name: "document_inspect", input: { kind: "body_blocks" } },
            { name: "document_insert_paragraphs", input: { texts: ["Inserted"], placement: { kind: "before", handle: "b0" } } }],
          [{ name: "finish", input: {} }],
        ][current]!;
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${current}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
        ] }) };
      } });
      let runtime: RunAgentResult | undefined;
      const deps = baseDeps(persistence, async (input) => runtime = await runAgent({ ...input, model }), undefined, 128_000);
      const document = () => ({ id: "doc-1", name: "Report.docx", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } });
      const execution = createAgentExecutionService({ ...deps, docxBinding: binding,
        documents: { ...deps.documents, listInWorkspace: async () => [document()] as never,
          getOwnedDocument: async () => document() as never,
          readExactVersionBytes: async ({ versionId: requested }) => { reads++; return requested === "v1" ? original : saved; },
          appendDocumentVersion: async (input) => {
            appends++; assert.equal(input.baseVersionId, "v1");
            saved = Buffer.from(input.bytes); versionId = "v2";
            return { version: { id: versionId, versionNumber: 2 } } as never;
          },
        },
      });
      const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Update this document: replace First, Second and Third, then insert a paragraph" })).result;
      assert.equal(result.run.status, "completed");
      assert.equal(appends, 1);
      assert.equal(runtime?.metrics.toolCalls.filter((call) => call.failureCode === "STALE_HANDLE").length, 1);
      assert.equal(runtime?.metrics.toolCalls.filter((call) => call.kind === "mutate" && call.outcome === "success").length, 4);
      assert.match(JSON.stringify(await realBinding.inspectDocx(saved, { focus: { kind: "body_blocks" } })), /Inserted/);
      assert.equal(persistence.messages.some((message) => message.content.includes("COMPLETE CURRENT DOCUMENT CONTENT")), false);
      if (tracing) {
        const trace = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
        const views = [...trace.matchAll(/## Turn \d+ — Request\n\n```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!).contextCounts.documentView);
        assert.deepEqual(views.map((view) => [view.workingRevision, view.snapshotRevision, view.dirty, view.refreshed]),
          [[0, 0, false, false], [3, 3, true, true], [3, 3, false, false], [4, 4, true, true]]);
        assert.ok(views.every((view) => view.characters > 0 && view.estimatedTokens > 0 && view.durationMs >= 0));
        t.diagnostic(`DIRECT regeneration durationMs: ${views.filter((view) => view.refreshed).map((view) => view.durationMs.toFixed(3)).join(", ")}`);
        assert.equal(trace.match(/Document View — Dirtied/g)?.length, 4);
      } else assert.equal(readdirSync(dir).length, 0);
    } finally {
      if (previousMode === undefined) delete process.env.AGENT_RUN_TRACE; else process.env.AGENT_RUN_TRACE = previousMode;
      if (previousDir === undefined) delete process.env.AGENT_RUN_TRACE_DIR; else process.env.AGENT_RUN_TRACE_DIR = previousDir;
      rmSync(dir, { recursive: true });
    }
  });
}

test("a failed DIRECT refresh removes the stale view, retries only after another edit, and saves once", async () => {
  const realBinding = await createNapiDocxEngineBinding();
  let loads = 0;
  const binding = { ...realBinding, inspectDocx: async (...args: Parameters<typeof realBinding.inspectDocx>) => {
    if (args[1].focus.kind === "body_blocks" && args[1].focus.limit === 100) loads++;
    return realBinding.inspectDocx(...args);
  } };
  const original = Buffer.from(buildMinimalDocx(["Small"]));
  const large = "x".repeat(30_000);
  const persistence = memoryPersistence("user-1");
  let appends = 0;
  const deps = baseDeps(persistence, async (input) => {
    const project = () => input.projectMessages!(input.messages);
    assert.match(JSON.stringify(await project()), /COMPLETE CURRENT DOCUMENT CONTENT/);
    const call = { toolCallId: "limit", messages: [], context: undefined as never };
    const replace = input.tools!["document.replace_text"]!.execute!;
    assert.equal((await replace({ target: { text: "Small" }, expectedCurrentText: "Small", replacement: large }, call) as { ok: boolean }).ok, true);
    assert.doesNotMatch(JSON.stringify(await project()), /COMPLETE CURRENT DOCUMENT CONTENT/);
    assert.equal(loads, 2);
    assert.doesNotMatch(JSON.stringify(await project()), /COMPLETE CURRENT DOCUMENT CONTENT/);
    assert.equal(loads, 2, "do not regenerate a failed snapshot with no new edit");
    const inspect = input.tools!["document.inspect"]!.execute!;
    assert.equal((await inspect({ kind: "overview" }, call) as { redundantReadSuppressed?: boolean }).redundantReadSuppressed, undefined);
    assert.equal((await inspect({ kind: "body_blocks" }, call) as { redundantReadSuppressed?: boolean }).redundantReadSuppressed, undefined);
    assert.equal((await replace({ target: { text: large }, expectedCurrentText: large, replacement: "Recovered" }, call) as { ok: boolean }).ok, true);
    assert.match(JSON.stringify(await project()), /Recovered/);
    assert.equal(loads, 3);
    assert.equal(appends, 0);
    return softResult("completed", "Done");
  }, undefined, 128_000);
  let versionId = "v1";
  let saved = original;
  const document = () => ({ id: "doc-1", name: "Small.docx", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } });
  const execution = createAgentExecutionService({ ...deps, docxBinding: binding,
    documents: { ...deps.documents, listInWorkspace: async () => [document()] as never,
      getOwnedDocument: async () => document() as never,
      readExactVersionBytes: async ({ versionId: requested }) => requested === "v1" ? original : saved,
      appendDocumentVersion: async (input) => {
        appends++; saved = Buffer.from(input.bytes); versionId = "v2";
        return { version: { id: versionId, versionNumber: 2 } } as never;
      },
    },
  });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Update this document: replace Small" })).result;
  assert.equal(result.run.status, "completed");
  assert.equal(appends, 1);
  assert.match(JSON.stringify(await realBinding.inspectDocx(saved, { focus: { kind: "body_blocks" } })), /Recovered/);
});

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
  workingDocumentIds: string[];
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
    workingDocumentIds: [] as string[],
    runs,
    steps,
    failOnStatus: undefined as AgentRun["status"] | undefined,
    async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
    async getOwnedThread() {
      return thread;
    },
    async listWorkingDocumentIds() {
      return [...api.workingDocumentIds];
    },
    async addWorkingDocuments(input: { documentIds: readonly string[] }) {
      api.workingDocumentIds.push(...input.documentIds.filter(
        (documentId) => !api.workingDocumentIds.includes(documentId),
      ));
    },
    async appendMessage(input: {
      threadId: string;
      ownerUserId: string;
      role: AgentMessage["role"];
      content: string;
      documentIds?: readonly string[];
    }) {
      const message: AgentMessage = {
        id: `msg-${++messageSeq}`,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        ...(input.documentIds?.length ? { documentIds: input.documentIds } : {}),
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
    async listRunsForTriggerMessages(input: { messageIds: readonly string[] }) {
      return [...runs.values()].filter((run) => run.triggeringMessageId && input.messageIds.includes(run.triggeringMessageId)).reverse();
    },
    async listToolNamesForRuns(input: { runIds: readonly string[] }) {
      return steps.filter((step) => input.runIds.includes(step.runId) && (step.kind === "tool" || step.kind === "inspect"))
        .map((step) => ({ runId: step.runId, name: step.name }));
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
          input.status === "completed_with_input_needed" ||
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
    async listStepsForRun(input: { runId: string }) {
      return steps.filter((step) => step.runId === input.runId);
    },
  };

  return api as unknown as AgentPersistenceService & {
    messages: AgentMessage[];
    checkpoint: AgentThreadContextCheckpoint | null;
    checkpoints: AgentThreadContextCheckpoint[];
    contextRowsLoaded: number[];
    compactionSourceRowsLoaded: number[];
    workingDocumentIds: string[];
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
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
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
      listInWorkspace: async () => [],
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

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.run.status, "completed");
  assert.equal(result.assistantMessage?.content, "All done");
  assert.equal(result.run.resultMessageId, result.assistantMessage?.id);
  assert.ok(events.some((e) => e.type === "agent.completed"));
  assert.equal(events.some((e) => e.type === "agent.failed"), false);
  assert.ok(sawSystem);
  assert.match(sawSystem!, /You are OpenSuite's document agent/);
  assert.match(sawSystem!, /INITIAL TOOLS/);
  assert.match(sawSystem!, /Use finish when the requested work is complete/);
  // Isolation fixture has no bound DOCX → only terminal tools are exposed.
  assert.match(sawSystem!, /- finish/);
  assert.doesNotMatch(sawSystem!.split("OPERATING PRINCIPLES")[0]!, /- document[._]/);
  assert.equal(sawSystem!.includes("document.capabilities"), false);
});

test("missing requested data preserves work and settles as input needed", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService(baseDeps(persistence, async (input) => {
    assert.ok(input.tools?.finish_with_input_needed);
    await input.onEvent?.({ type: "text_delta", delta: "KPIs updated. Budget unchanged; new budget figures are needed." });
    await input.onEvent?.({ type: "tool_started", toolCallId: "finish-1", toolName: "finish_with_input_needed" });
    await input.tools.finish_with_input_needed.execute!({ missingInformation: "New budget figures" }, { toolCallId: "finish-1", messages: [], context: undefined as never });
    await input.onEvent?.({ type: "tool_completed", toolCallId: "finish-1", toolName: "finish_with_input_needed" });
    const result = softResult("finish_tool", "KPIs updated. Budget unchanged; new budget figures are needed.");
    return { ...result, metrics: { ...result.metrics, toolCalls: [{ sequence: 0, turn: 1, toolName: "finish_with_input_needed", kind: "read", durationMs: 0, outcome: "success" }] } };
  }));
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Update KPIs and budget" })).result;
  assert.equal(result.run.status, "completed_with_input_needed");
  assert.equal(result.run.errorCode, null);
  assert.match(result.assistantMessage?.content ?? "", /Budget unchanged/);
  assert.deepEqual(persistence.steps.map((step) => step.name), ["finish_with_input_needed"]);
});

for (const editFirst of [false, true]) {
  test(`clarification ${editFirst ? "preserves earlier edits" : "leaves the document unchanged"}, traces input needed and accepts a normal follow-up`, async () => {
    const previousMode = process.env.AGENT_RUN_TRACE;
    const previousDir = process.env.AGENT_RUN_TRACE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "opensuite-clarification-"));
    process.env.AGENT_RUN_TRACE = "full";
    process.env.AGENT_RUN_TRACE_DIR = dir;
    try {
      const persistence = memoryPersistence("user-1");
      const binding = await createNapiDocxEngineBinding();
      const initialBytes = Buffer.from(buildMinimalDocx(["September 2026 Operating Review", "Priorities for October", "Draft"]));
      const versions = new Map([["v1", initialBytes]]);
      let versionId = "v1";
      let turn = 0;
      const question = "The report is for September with October priorities. Should I roll it to October with November priorities, or November with December priorities?";
      const replace = (text: string, replacement: string) => ({ name: "document_replace_text", input: { target: { text }, expectedCurrentText: text, replacement } });
      const calls = [
        ...(editFirst ? [[replace("Draft", "Reviewed")]] : []),
        [{ name: "request_clarification", input: { question } }],
        [replace("September 2026", "October 2026"), replace("Priorities for October", "Priorities for November")],
        [{ name: "finish", input: {} }],
      ];
      const model = new MockLanguageModelV4({ doStream: async (options) => {
        const names = options.tools!.map((tool) => tool.name);
        assert.ok(names.includes("request_clarification"));
        assert.equal(names.includes("document_set_table_cells_formatting"), false);
        const current = calls[turn++]!;
        const text = current[0]!.name === "request_clarification" && editFirst ? question : current[0]!.name === "finish" ? "Updated to October." : null;
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...(text ? [{ type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" }] : []),
          ...current.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
        ] }) };
      } });
      const runtimeResults: RunAgentResult[] = [];
      const events: AgentEvent[] = [];
      const reports: AgentRunReport[] = [];
      const deps = baseDeps(persistence, async (input) => {
        const clarification = input.tools!.request_clarification!;
        assert.equal(clarification.kind, "read");
        assert.equal(clarification.terminal, true);
        const schema = (clarification.inputSchema as { jsonSchema: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> } }).jsonSchema;
        assert.deepEqual(schema.required, ["question"]);
        assert.deepEqual(Object.keys(schema.properties), ["question"]);
        assert.equal(schema.additionalProperties, false);
        const context = { toolCallId: "invalid", messages: [], context: undefined as never };
        for (const question of ["", "  ", 3, undefined]) {
          assert.throws(() => clarification.execute!({ question }, context), /A clarification question is required/);
        }
        assert.equal(clarification.execute!({ question: "  Which period?  " }, context), "Which period?");
        if (runtimeResults.length) {
          assert.ok(JSON.stringify(input.messages).includes(question), "follow-up includes the durable question");
          assert.ok(JSON.stringify(input.messages).includes("Update this document: change October to November"), "follow-up includes the original request");
        }
        const result = await runAgent({ ...input, model });
        runtimeResults.push(result);
        return result;
      });
      const document = () => ({ id: "doc-1", name: "Report.docx", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } });
      const execution = createAgentExecutionService({ ...deps, docxBinding: binding,
        agentRunReportSink: (report) => { reports.push(report); },
        documents: { ...deps.documents, listInWorkspace: async () => [document()] as never,
          getOwnedDocument: async () => document() as never,
          readExactVersionBytes: async (input) => versions.get(input.versionId)!,
          appendDocumentVersion: async (input) => {
            assert.equal(input.baseVersionId, versionId);
            versionId = `v${versions.size + 1}`;
            versions.set(versionId, Buffer.from(input.bytes));
            return { version: { id: versionId, versionNumber: versions.size } } as never;
          },
        },
      });
      const start = (instruction: string) => execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction, liveEvents: { emit: (event) => { events.push(event); } } });
      const first = await (await start("Update this document: change October to November and replace Priorities for November with December priorities.")).result;
      assert.equal(first.run.status, "completed_with_input_needed");
      assert.equal(first.run.errorCode, null);
      assert.equal(first.run.resultMessageId, first.assistantMessage?.id);
      assert.equal(first.assistantMessage?.content, question);
      assert.equal(runtimeResults[0]!.stopReason, "finish_tool");
      assert.equal(runtimeResults[0]!.turns, editFirst ? 2 : 1);
      assert.equal(reports[0]?.document?.workingMutationCount, editFirst ? 1 : 0);
      assert.equal(reports[0]?.document?.versionAdvances.length, editFirst ? 1 : 0);
      assert.equal(versions.size, editFirst ? 2 : 1);
      if (!editFirst) assert.deepEqual(versions.get(versionId), initialBytes);
      else assert.match(JSON.stringify(await binding.inspectDocx(versions.get(versionId)!, { focus: { kind: "body_blocks" } })), /Reviewed/);
      assert.equal(runtimeResults[0]!.metrics.toolCalls.at(-1)?.kind, "read");
      assert.equal(events.filter((event) => event.type === "document.working.updated").length, editFirst ? 1 : 0);
      assert.equal(events.filter((event) => event.type === "document.version.advanced").length, editFirst ? 1 : 0);
      assert.ok(events.some((event) => event.type === "message.completed" && event.content === question));
      assert.ok(events.some((event) => event.type === "agent.completed"));
      assert.equal(persistence.steps.filter((step) => step.kind === "narration").length, 0, "question is not duplicated as narration");
      const trace = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
      assert.match(trace, /Tool Result — request_clarification/);
      assert.match(trace, /"rawResult":/);
      assert.match(trace, /"stopReason": "finish_tool"/);
      assert.match(trace, /"status": "completed_with_input_needed"/);
      assert.ok(trace.includes(question));
      assert.equal(trace.includes("## Document Version Created"), editFirst);

      const followUp = await (await start("Update this document: use October 2026 as the reporting period, with November priorities.")).result;
      assert.equal(followUp.thread.id, first.thread.id);
      assert.notEqual(followUp.run.id, first.run.id);
      assert.equal(followUp.run.status, "completed");
      assert.equal(followUp.assistantMessage?.content, "Updated to October.");
      assert.equal(followUp.run.baseDocumentVersionId, editFirst ? "v2" : "v1");
      assert.equal(versions.size, editFirst ? 3 : 2);
      const saved = JSON.stringify(await binding.inspectDocx(versions.get(versionId)!, { focus: { kind: "body_blocks" } }));
      assert.match(saved, /October 2026 Operating Review/);
      assert.match(saved, /Priorities for November/);
      if (editFirst) assert.match(saved, /Reviewed/);
    } finally {
      if (previousMode === undefined) delete process.env.AGENT_RUN_TRACE; else process.env.AGENT_RUN_TRACE = previousMode;
      if (previousDir === undefined) delete process.env.AGENT_RUN_TRACE_DIR; else process.env.AGENT_RUN_TRACE_DIR = previousDir;
      rmSync(dir, { recursive: true });
    }
  });
}

test("managed AI failure keeps a safe, actionable reason on the run", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async () => { throw new Error("model should not run"); }),
    resolveModel: async () => ({ model: { provider: "test", modelId: "test" } as unknown as V3Model,
      usageAttribution: { provider: "openrouter", model: "test", credentialSource: "managed" } }),
    managedUsagePolicy: { beforeManagedCall: async () => { throw Object.assign(new Error("Managed AI is not available."), { code: "MANAGED_USAGE_DISABLED" }); },
      afterUsageRecorded: async () => {}, status: async () => ({ enabled: false, originalGrantMicros: 0, balanceMicros: 0, displayGrantCredits: 0, exhausted: true }) },
  });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Make a document" })).result;
  assert.equal(result.run.errorCode, "MANAGED_USAGE_DISABLED");
  assert.equal(result.run.errorMessage, "Managed AI is unavailable. Add your own API key in AI & Models settings.");
});

test("known document and provider failures have specific safe explanations", () => {
  assert.deepEqual(describeRunFailure(new Error("No output generated"), [
    { kind: "tool", status: "failed", name: "document.insert_paragraphs", summary: "Failed: NO_ACTIVE_DOCUMENT" },
  ]), { code: "NO_ACTIVE_DOCUMENT", message: "No document was active, and the agent tried to edit before creating one. Retry the request or open a document first." });
  assert.equal(describeRunFailure(new Error("Invalid 'input[3].name': bad"), [])?.code, "MODEL_TOOL_NAME_REJECTED");
  assert.equal(describeRunFailure(new Error("Invalid 'tools[0].name': string does not match pattern"), [])?.code, "MODEL_TOOL_NAME_REJECTED");
  assert.equal(describeRunFailure(new Error("database password is secret"), []), null);
});

test("managed AI plain errors still map to actionable user-facing copy", () => {
  assert.deepEqual(describeRunFailure(new Error("Managed AI is unavailable."), []), {
    code: "MANAGED_USAGE_EXHAUSTED",
    message: "Managed AI credits are exhausted. Add your own API key in AI & Models settings.",
  });
  assert.deepEqual(describeRunFailure(new Error("Managed AI is not available."), []), {
    code: "MANAGED_USAGE_DISABLED",
    message: "Managed AI is unavailable. Add your own API key in AI & Models settings.",
  });
  assert.deepEqual(describeRunFailure(new Error("Managed AI accounting is unavailable."), []), {
    code: "MANAGED_USAGE_ACCOUNTING_FAILED",
    message: "Managed AI is temporarily unavailable. Use your own API key or try again later.",
  });
});

test("a document creation run tells the model to create before editing", async () => {
  const persistence = memoryPersistence("user-1");
  let system = "";
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async (input) => { system = input.system ?? ""; return softResult("completed", "Done"); }),
    docxBinding: { getDocxCapabilities: () => ({ ok: true, formats: [] }) } as unknown as AgentExecutionServiceDeps["docxBinding"],
  });
  await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Create a research document" })).result;
  assert.match(system, /No document is selected for editing\. Create one for a new-document request/);
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

test("agent run report sink receives one composed report", async () => {
  const persistence = memoryPersistence("user-1");
  const reports: { runId: string; outcome: string; stopReason?: string }[] = [];
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async () => softResult("completed", "Hello")),
    agentRunReportSink: async (report) => {
      reports.push(report);
    },
  });

  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "hi",
    })
  ).result;

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.run.status, "completed");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.runId, result.run.id);
  assert.equal(reports[0]?.outcome, "success");
  assert.equal(reports[0]?.stopReason, "completed");
});

test("agent run report sink failure does not alter the run", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async () => softResult("completed", "Hello")),
    agentRunReportSink: async () => {
      throw new Error("telemetry unavailable");
    },
  });

  const result = await (
    await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "hi",
    })
  ).result;

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.run.status, "completed");
  assert.equal(result.assistantMessage?.content, "Hello");
});

test("later runs restore durable working documents into model context", async () => {
  const persistence = memoryPersistence("user-1");
  const artifacts = [
    { id: "doc-a", name: "A.docx", format: "docx" as const, workspaceId: "ws-1", latestVersion: { id: "v-a", versionNumber: 1, sizeBytes: 1, source: "upload" as const, createdAt: now() }, createdAt: now(), updatedAt: now(), starred: false },
    { id: "doc-b", name: "B.docx", format: "docx" as const, workspaceId: "ws-1", latestVersion: { id: "v-b", versionNumber: 1, sizeBytes: 1, source: "upload" as const, createdAt: now() }, createdAt: now(), updatedAt: now(), starred: false },
  ];
  let projected: readonly { readonly role: string; readonly content: unknown }[] = [];
  const deps = {
    ...baseDeps(persistence, async (input) => {
      projected = await input.projectMessages!(input.messages) as typeof projected;
      return softResult("completed", "done");
    }, undefined, 10_000),
    documents: {
      listInWorkspace: async () => artifacts,
      getOwnedDocument: async ({ documentId }: { documentId: string }) => {
        const document = artifacts.find((item) => item.id === documentId);
        if (!document) throw new Error("missing document");
        return document;
      },
      readExactVersionBytes: async () => Buffer.alloc(0),
      appendDocumentVersion: async () => { throw new Error("no append"); },
      createBlankDocxDocument: async () => { throw new Error("no blank"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("no create"); },
    },
    docxBinding: {
      getDocxCapabilities: () => ({
        ok: true,
        protocolVersion: 1,
        engineVersion: "test",
        formats: [{ format: "docx", capabilities: [] }],
      }),
      inspectDocx: async () => ({
        ok: true,
        diagnostics: [],
        bodyBlocks: { page: { total: 0, offset: 0, returned: 0, hasMore: false }, items: [] },
      }),
    } as unknown as AgentExecutionServiceDeps["docxBinding"],
  } satisfies AgentExecutionServiceDeps;
  const execution = createAgentExecutionService(deps);

  const first = await (await execution.start({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "Update this document first",
    activeDocumentId: "doc-a",
    documentIds: ["doc-b"],
  })).result;
  assert.equal(first.run.baseDocumentVersionId, "v-a");
  assert.deepEqual(first.userMessage.documentIds, ["doc-b"]);
  assert.deepEqual(new Set(persistence.workingDocumentIds), new Set(["doc-a", "doc-b"]));

  const logs: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => logs.push(String(message));
  try {
    const second = await (await execution.start({
      userId: "user-1",
      threadId: "thread-1",
      instruction: "Update this document second",
      activeDocumentId: "doc-b",
      documentIds: ["doc-a"],
    })).result;
    assert.equal(second.run.baseDocumentVersionId, "v-b");
  } finally {
    console.info = original;
  }
  assert.match(String(projected.at(-2)?.content), /WORKING SET\n- B\.docx \(docx; ID doc-b; tip v1; version v-b\)\n- A\.docx \(docx; ID doc-a; tip v1; version v-a\)/);
  assert.equal(projected.at(-1)?.content, "Update this document second");
  assert.ok(logs.some((message) =>
    message.includes("[agent] RETRIEVAL") &&
    message.includes("target=B.docx") &&
    message.includes("sources=A.docx") &&
    message.includes("2 docs"),
  ));
});

test("only an explicit current-document request binds the open DOCX before model selection", async () => {
  const persistence = memoryPersistence("user-1");
  const documents = [
    { id: "open", name: "Open.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "v-open", versionNumber: 1 }, updatedAt: now() },
    { id: "board", name: "Board Report.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "v-board", versionNumber: 2 }, updatedAt: now() },
  ];
  const contexts: string[] = [];
  const deps = baseDeps(persistence, async (input) => {
    contexts.push(JSON.stringify(await input.projectMessages!(input.messages)));
    return softResult("completed", "done");
  });
  const execution = createAgentExecutionService({ ...deps,
    docxBinding: { getDocxCapabilities: () => ({ ok: true, protocolVersion: 1, engineVersion: "test", formats: [{ format: "docx", capabilities: [] }] }) } as unknown as AgentExecutionServiceDeps["docxBinding"],
    documents: { ...deps.documents,
      listInWorkspace: async () => documents as never,
      getOwnedDocument: async ({ documentId }) => documents.find((document) => document.id === documentId) as never,
    },
  });
  const named = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "open", instruction: "Update the Board Report" })).result;
  assert.equal(named.run.baseDocumentVersionId, null);
  assert.match(contexts[0]!, /\[OPEN\] Open\.docx/);
  assert.match(contexts[0]!, /Board Report\.docx \(docx; ID board;/);
  const current = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "open", instruction: "Update this document" })).result;
  assert.equal(current.run.baseDocumentVersionId, "v-open");
});

test("DOCX edit fails clearly when the engine is unavailable while workspace chat still runs", async () => {
  const persistence = memoryPersistence("user-1");
  let modelCalls = 0;
  const deps = baseDeps(persistence, async () => { modelCalls++; return softResult("completed", "done"); });
  const document = { id: "doc", name: "Report.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "v1" } };
  const execution = createAgentExecutionService({ ...deps, documents: { ...deps.documents,
    listInWorkspace: async () => [document] as never,
    getOwnedDocument: async () => document as never,
  } });
  await assert.rejects(execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc", instruction: "Update this document" }),
    (error: unknown) => (error as { code?: string }).code === "DOCX_ENGINE_UNAVAILABLE");
  assert.equal(modelCalls, 0);
  const chat = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Which documents are here?" })).result;
  assert.equal(chat.run.status, "completed");
  assert.equal(modelCalls, 1);
});

test("recurring report refresh selects the target, reads the source, and saves one target version", async () => {
  const persistence = memoryPersistence("user-1");
  const binding = await createNapiDocxEngineBinding();
  const target = Buffer.from(buildMinimalDocx(["August report", "Revenue: 10", "Budget: 20", "Unrelated note"]));
  const source = Buffer.from(buildMinimalDocx(["September updates", "Revenue: 12"]));
  let savedTarget = target;
  let targetVersion = "target-v1";
  let appends = 0;
  const artifacts = [
    { id: "target", name: "August report.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: targetVersion } },
    { id: "source", name: "September updates.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "source-v1" } },
  ];
  const call = { toolCallId: "refresh", messages: [], context: undefined as never };
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async (input) => {
      const projected = await input.projectMessages!(input.messages);
      assert.match(input.system ?? "", /DOCUMENT UPDATE RULE/);
      assert.match(JSON.stringify(projected), /WORKSPACE MANIFEST/);
      assert.match(JSON.stringify(projected), /ID target/);
      assert.match(JSON.stringify(projected), /ID source/);
      const tools = input.tools!;
      assert.equal((await tools["workspace.select_document"]!.execute!({ documentId: "target" }, call) as { ok: boolean }).ok, true);
      const updates = await tools["workspace.inspect_document"]!.execute!({ documentId: "source", kind: "body_blocks" }, call);
      assert.match(JSON.stringify(updates), /Revenue: 12/);
      for (const [oldText, newText] of [["August report", "September report"], ["Revenue: 10", "Revenue: 12"]]) {
        assert.equal((await tools["document.replace_text"]!.execute!({ target: { text: oldText }, expectedCurrentText: oldText, replacement: newText }, call) as { ok: boolean }).ok, true);
      }
      assert.equal((await tools["workspace.select_document"]!.execute!({ documentId: "source" }, call) as { reasonCode: string }).reasonCode, "DOCUMENT_ALREADY_EDITED");
      assert.match(JSON.stringify(await tools["workspace.inspect_document"]!.execute!({ documentId: "source", kind: "body_blocks" }, call)), /Revenue: 12/);
      return softResult("completed", "Updated the report.");
    }, undefined, 100_000),
    docxBinding: binding,
    documents: {
      listInWorkspace: async () => artifacts as never,
      getOwnedDocument: async ({ documentId }) => {
        const document = artifacts.find((item) => item.id === documentId);
        if (!document) throw new Error("missing document");
        return document as never;
      },
      readExactVersionBytes: async ({ documentId, versionId }) => {
        if (documentId === "target" && versionId === "target-v1") return target;
        if (documentId === "target" && versionId === "target-v2") return savedTarget;
        if (documentId === "source" && versionId === "source-v1") return source;
        throw new Error("wrong version");
      },
      appendDocumentVersion: async ({ documentId, baseVersionId, bytes }) => {
        assert.equal(documentId, "target");
        assert.equal(baseVersionId, "target-v1");
        appends++;
        savedTarget = Buffer.from(bytes);
        targetVersion = "target-v2";
        return { version: { id: targetVersion, versionNumber: 2 } } as never;
      },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  const result = await (await execution.start({
    userId: "user-1", threadId: "thread-1", activeDocumentId: "source",
    documentIds: ["target"],
    instruction: "Update the August report into the September report using the attached updates. Preserve the existing structure and formatting.",
  })).result;
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.baseDocumentVersionId, null);
  assert.equal(appends, 1);
  assert.equal(artifacts[1]!.latestVersion.id, "source-v1");
  assert.match(JSON.stringify(await binding.inspectDocx(savedTarget, { focus: { kind: "body_blocks" } })), /September report/);
  assert.match(JSON.stringify(await binding.inspectDocx(savedTarget, { focus: { kind: "body_blocks" } })), /Revenue: 12/);
  assert.match(JSON.stringify(await binding.inspectDocx(savedTarget, { focus: { kind: "body_blocks" } })), /Budget: 20/);
  assert.match(JSON.stringify(await binding.inspectDocx(savedTarget, { focus: { kind: "body_blocks" } })), /Unrelated note/);
  assert.deepEqual(source, Buffer.from(buildMinimalDocx(["September updates", "Revenue: 12"])));
});

test("creating a new report does not bind or retrieve a stale active document", async () => {
  const persistence = memoryPersistence("user-1");
  persistence.workingDocumentIds.push("old");
  const old = { id: "old", name: "Prior report.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "old-v1" } };
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async (input) => {
      assert.match(input.system ?? "", /No document is active/);
      assert.doesNotMatch(input.system ?? "", /DOCUMENT UPDATE RULE/);
      assert.doesNotMatch(JSON.stringify(await input.projectMessages!(input.messages)), /Prior report/);
      return softResult("completed", "Ready to create the report.");
    }),
    documents: {
      listInWorkspace: async () => [old] as never,
      getOwnedDocument: async () => old as never,
      readExactVersionBytes: async () => { throw new Error("stale document was read"); },
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
    docxBinding: { getDocxCapabilities: () => ({ ok: true, protocolVersion: 1, engineVersion: "test", formats: [{ format: "docx", capabilities: [] }] }) } as unknown as AgentExecutionServiceDeps["docxBinding"],
  });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "old", instruction: "Create a new monthly report" })).result;
  assert.equal(result.run.baseDocumentVersionId, null);
});

test('scripted report creation applies the loaded skill workspace brand before saving', async () => {
  const persistence = memoryPersistence('user-1');
  const binding = await createNapiDocxEngineBinding();
  const versions = new Map<string, Buffer>();
  let document = { id: 'report-1', name: 'Q3 report.docx', workspaceId: 'ws-1', format: 'docx', latestVersion: { id: 'v1' } };
  let brandReads = 0;
  let logoReads = 0;
  const logoPng = await sharp({ create: { width: 1600, height: 800, channels: 4, background: '#124733' } }).png().toBuffer();
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async (input) => {
      const firstTurn = await input.projectTools!({ turn: 1 } as never);
      await firstTurn['capabilities.load']!.execute!({ ids: ['skills.reporting.analytical-report'] }, {} as never);
      const tools = await input.projectTools!({ turn: 2 } as never);
      await tools['workspace.create_blank_document']!.execute!({ title: document.name }, {} as never);
      await tools['document.insert_paragraphs']!.execute!({ texts: ['Q3 operating report', 'Executive Summary', 'Revenue: $3.8M'], placement: { kind: 'end' } }, {} as never);
      await tools['document.set_paragraph_style']!.execute!({ target: { text: 'Q3 operating report' }, style: 'Title' }, {} as never);
      await tools['document.set_paragraph_style']!.execute!({ target: { text: 'Executive Summary' }, style: 'Heading 1' }, {} as never);
      await tools['document.create_table']!.execute!({ placement: { kind: 'end' }, rows: [['Metric', 'Value'], ['Revenue', '$3.8M']] }, {} as never);
      return softResult('completed', 'Created.');
    }),
    docxBinding: binding,
    documents: {
      listInWorkspace: async () => [],
      getOwnedDocument: async () => document as never,
      readExactVersionBytes: async ({ versionId }) => versions.get(versionId)!,
      appendDocumentVersion: async ({ bytes }) => {
        versions.set('v2', Buffer.from(bytes));
        document = { ...document, latestVersion: { id: 'v2' } };
        return { version: { id: 'v2', versionNumber: 2 } } as never;
      },
      createBlankDocxDocument: async () => {
        versions.set('v1', Buffer.from(binding.createBlankDocx()));
        return { document, version: { id: 'v1', versionNumber: 1 } } as never;
      },
      createOfficeDocumentFromBytes: async () => { throw new Error('unused'); },
    },
    workspaceBrand: { get: async () => {
      brandReads++;
      return { schemaVersion: 1, workspaceId: 'ws-1', createdAt: '', updatedAt: '', logoAssetId: 'logo-1',
        organization: { name: 'Cincinnati Sports Club', website: '', email: '', phone: '', address: '' },
        colors: { primary: '#124733', secondary: '#124733', accent: '#124733' }, typography: { headingFont: 'Arial', bodyFont: 'Arial' } };
    } },
    workspaceAssets: {
      listImages: async () => ({ items: [], offset: 0, limit: 20 }),
      readBytes: async () => {
        logoReads++;
        return { bytes: logoPng, contentType: 'image/png' };
      },
    },
  });
  const result = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Create a professional quarterly operating report with metrics.' })).result;
  assert.equal(result.run.status, 'completed');
  assert.equal(brandReads, 1);
  assert.equal(logoReads, 1);
  const snapshot = await inspectDocxStyleSnapshot(new Uint8Array(versions.get('v2')!), binding);
  assert.equal(snapshot.tables[0]?.firstRowShadingColors[0], '124733');
  assert.ok(snapshot.typography.textColors.some((color) => color.value === 'FFFFFF'));
  for (const styleId of ['Title', 'Heading1']) {
    assert.ok(snapshot.typography.runPatterns.some((pattern) => pattern.paragraphStyleId === styleId && (pattern.effectiveFormatting ?? pattern.directFormatting).color === '124733'), styleId);
  }
  assert.ok(snapshot.typography.runPatterns.some((pattern) => (pattern.effectiveFormatting ?? pattern.directFormatting).fontFamily === 'Arial'));
  const blocks = await binding.inspectDocx(new Uint8Array(versions.get('v2')!), { focus: { kind: 'body_blocks', offset: 0, limit: 1 } });
  assert.equal(blocks.bodyBlocks?.items[0]?.kind, 'picture');
  assert.ok((blocks.bodyBlocks?.items[0]?.picture?.widthEmu ?? Infinity) <= 1_371_600);
  assert.ok((blocks.bodyBlocks?.items[0]?.picture?.heightEmu ?? Infinity) <= 457_200);
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

test("one-turn finish tool does not persist the final answer as narration", async () => {
  const persistence = memoryPersistence("user-1");
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      await input.onEvent?.({ type: "text_delta", delta: "Hello world" });
      await input.onEvent?.({ type: "tool_started", toolCallId: "fin-1", toolName: "finish" });
      await input.onEvent?.({ type: "tool_completed", toolCallId: "fin-1", toolName: "finish" });
      return softResult("finish_tool", "Hello world");
    }),
  );

  const settled = await (
    await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "hi" })
  ).result;

  assert.deepEqual(
    persistence.steps.map((step) => [step.sequence, step.kind, step.status, step.name, step.summary]),
    [[0, "tool", "completed", "finish", "Completed"]],
  );
  const assistant = persistence.messages.filter((message) => message.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.content, "Hello world");
  assert.equal(settled.run.resultMessageId, assistant[0]?.id);
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
  assert.ok(historical.length > 0 && historical.length <= MAX_HISTORY_MESSAGES);
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
    assert.equal(result.run.errorMessage, "Reached the 20 AI-turn limit before completing the task.");
    assert.equal(result.assistantMessage?.content, result.run.errorMessage);
    assert.equal(result.run.resultMessageId, result.assistantMessage?.id);
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

  const firstResultId = [...persistence.runs.values()][0]?.resultMessageId;
  const continued = await (await execution.start({
    userId: "user-1",
    threadId: "thread-1",
    instruction: "Continue",
    continueFromRunId: [...persistence.runs.values()][0]!.id,
  })).result;
  assert.notEqual(continued.run.resultMessageId, firstResultId);
  assert.deepEqual(persistence.messages.map((message) => message.content), [
    "edit the doc",
    "Reached the 20 AI-turn limit before completing the task.",
    "Continue",
    "Reached the 20 AI-turn limit before completing the task.",
  ]);
});

test("configured output limit reaches the runtime and length stop fails the run", async () => {
  const persistence = memoryPersistence("user-1");
  const reports: AgentRunReport[] = [];
  let requestedLimit: number | undefined;
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async (input) => {
      requestedLimit = input.maxOutputTokens;
      return softResult("output_limit");
    }),
    resolveModel: async () => ({
      model: { provider: "test", modelId: "test" } as unknown as V3Model,
      contextLength: 1_048_576,
      maxOutputTokens: 943_718,
      outputTokenLimit: 12_288,
    }),
    agentRunReportSink: (report) => { reports.push(report); },
  });
  const result = await (await execution.start({
    userId: "user-1", threadId: "thread-1", instruction: "edit",
  })).result;
  assert.equal(requestedLimit, 12_288);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_OUTPUT_LIMIT");
  assert.equal(result.assistantMessage?.content, "The AI response reached its output limit before completing the task.");
  assert.equal(reports[0]?.context?.outputReserveTokens, 12_288);
});

test("terminal runs flush valid working changes once, including partial and cancelled runs", async () => {
  const binding = await createNapiDocxEngineBinding();
  for (const mode of ["completed", "max_turns", "cancelled", "throw", "read_only", "fail_before", "append_fail"] as const) {
    const persistence = memoryPersistence("user-1");
    let bytes = Buffer.from(buildMinimalDocx(["Start"]));
    let versionId = "v1";
    let appends = 0;
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const reports: AgentRunReport[] = [];
    const controller = new AbortController();
    const deps = baseDeps(persistence, async (input) => {
      modelCalls++;
      if (mode === "fail_before") throw new Error("model failed");
      const call = { toolCallId: "test", messages: [], context: undefined as never };
      if (mode === "read_only") {
        await input.tools!["document.inspect"]!.execute!({ kind: "body_blocks" }, call);
      } else {
        for (let i = 0; i < 3; i++) {
          const result = await input.tools!["document.insert_paragraph"]!.execute!({ text: `Edit ${i}`, placement: { kind: "end" } }, call);
          assert.equal((result as { ok: boolean }).ok, true);
        }
      }
      if (mode === "throw") throw new Error("model failed after edits");
      if (mode === "cancelled") { controller.abort(); throw new Error("cancelled"); }
      return softResult(mode === "max_turns" ? "max_turns" : "completed");
    });
    const execution = createAgentExecutionService({
      ...deps,
      docxBinding: binding,
      agentRunReportSink: (report) => { reports.push(report); },
      documents: {
        ...deps.documents,
        getOwnedDocument: async () => ({ id: "doc-1", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } }) as never,
        readExactVersionBytes: async () => bytes,
        appendDocumentVersion: async (input) => {
          assert.equal(input.baseVersionId, "v1");
          appends++;
          if (mode === "append_fail") throw new Error("storage unavailable");
          bytes = Buffer.from(input.bytes);
          versionId = "v2";
          return { version: { id: "v2", versionNumber: 2 } } as never;
        },
      },
    });
    const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Edit this document", signal: controller.signal, liveEvents: { emit: (event) => { events.push(event); } } })).result;
    assert.equal(modelCalls, 1, `verification must not add a model turn: ${mode}`);
    assert.equal(persistence.steps.some((step) => step.kind === "validation"), appends > 0 && mode !== "append_fail", mode);
    assert.equal(appends, mode === "read_only" || mode === "fail_before" ? 0 : 1, mode);
    assert.equal(events.filter((event) => event.type === "document.version.advanced").length, mode === "append_fail" ? 0 : appends, mode);
    assert.equal(events.filter((event) => event.type === "document.working.updated").length,
      mode === "read_only" || mode === "fail_before" ? 0 : 3, mode);
    assert.equal(result.run.status, mode === "completed" || mode === "read_only" ? "completed" : mode === "cancelled" ? "cancelled" : "failed", mode);
    if (mode === "append_fail") assert.equal(result.run.errorCode, "AGENT_PERSISTENCE_FAILED");
    if (mode !== "throw" && mode !== "cancelled" && mode !== "fail_before") {
      assert.equal(reports[0]?.document?.workingMutationCount, mode === "read_only" ? 0 : 3, mode);
      assert.equal(reports[0]?.document?.versionAdvances.length, mode === "read_only" || mode === "append_fail" ? 0 : 1, mode);
      assert.equal(reports[0]?.document?.finalVersionId, mode === "read_only" || mode === "append_fail" ? "v1" : "v2", mode);
    }
    if (appends && mode !== "append_fail") assert.match(JSON.stringify(await binding.inspectDocx(bytes, { focus: { kind: "body_blocks" } })), /Edit 2/);
  }
});

test("execution scopes compatible handle reuse to the model turn and saves one version", async () => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Start"]) });
  assert.equal((await seed.mutate("create_table", {
    rows: [["Item", "Owner"], ["Plan", "Alice"]], placement: { kind: "end" },
  })).ok, true);
  let bytes = Buffer.from(seed.currentBytes());
  let versionId = "v1";
  let appends = 0;
  const persistence = memoryPersistence("user-1");
  let turn = 0;
  let table: { handle: string };
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const names = options.tools!.map((tool) => tool.name);
    assert.equal(names.includes("document_set_table_formatting"), turn > 0);
    if (turn === 1) {
      const results = options.prompt.filter((message) => message.role === "tool")
        .flatMap((message) => message.content).filter((part) => part.type === "tool-result");
      const inspected = results.find((part) => part.toolName === "document_inspect")!.output as {
        type: "json"; value: { tables: { items: { handle: string }[] } };
      };
      table = { handle: inspected.value.tables.items[0]!.handle };
    }
    const calls = [
      [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }, { name: "document_inspect", input: { kind: "tables" } }],
      [{ name: "document_set_table_formatting", input: { table, borders: "grid" } }, { name: "document_set_table_column_widths", input: { table, widthsTwips: [3000, 3000] } }],
      [{ name: "document_set_table_column_widths", input: { table, widthsTwips: [2000, 4000] } }, { name: "finish", input: {} }],
      [{ name: "finish", input: {} }],
    ][turn++]!;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  let runtimeResult: RunAgentResult;
  const deps = baseDeps(persistence, async (input) => {
    assert.ok(input.projectTools);
    assert.match(input.system!, /document: Read and edit DOCX documents/);
    assert.doesNotMatch(input.system!, /- document_set_table_formatting/);
    runtimeResult = await runAgent({ ...input, model });
    return runtimeResult;
  });
  const reports: AgentRunReport[] = [];
  const execution = createAgentExecutionService({
    ...deps, docxBinding: binding,
    agentRunReportSink: (report) => { reports.push(report); },
    documents: {
      ...deps.documents,
      getOwnedDocument: async () => ({ id: "doc-1", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } }) as never,
      readExactVersionBytes: async () => bytes,
      appendDocumentVersion: async (input) => {
        assert.equal(input.baseVersionId, "v1");
        bytes = Buffer.from(input.bytes);
        versionId = "v2";
        appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
    },
  });
  const result = await (await execution.start({
    userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Format this document",
  })).result;
  // The second column-width attempt intentionally fails with STALE_HANDLE after
  // earlier successful edits — preserve those edits but do not claim full success.
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
  assert.equal(appends, 1);
  assert.equal(reports[0]?.outcome, "partial");
  assert.equal(reports[0]?.document?.workingMutationCount, 2);
  assert.equal(reports[0]?.document?.finalVersionId, "v2");
  assert.equal(runtimeResult!.stopReason, "finish_tool");
  assert.deepEqual(runtimeResult!.metrics.modelTurns.map((turn) => turn.exposedToolCount), [21, 25, 25, 25]);
  assert.deepEqual(runtimeResult!.metrics.toolCalls.map((call) => call.failureCode), [undefined, undefined, undefined, undefined, undefined, "STALE_HANDLE", undefined]);
});

test("max_turns reports preserved changes only after a version advance", () => {
  assert.equal(
    boundedStopMessage("max_turns", true),
    "Reached the 20 AI-turn limit before completing the task. Changes made so far were preserved.",
  );
  assert.equal(boundedStopMessage("max_turns", false), "Reached the 20 AI-turn limit before completing the task.");
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
  persistence.steps.push(
    { runId: partial.id, sequence: 0, kind: "tool", status: "completed", name: "document.insert_paragraph", summary: "Completed" },
    { runId: partial.id, sequence: 1, kind: "tool", status: "failed", name: "document.set_style", summary: "Failed: STYLE_NOT_FOUND" },
  );

  let observedMaxTurns: number | undefined;
  let observedModelText = "";
  let repeatedMutation = false;
  const execution = createAgentExecutionService(
    baseDeps(persistence, async (input) => {
      observedMaxTurns = input.maxTurns;
      observedModelText = input.messages.map((message) => String(message.content)).join("\n");
      repeatedMutation = !observedModelText.includes("document.insert_paragraph ×1");
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
  assert.match(observedModelText, /document.insert_paragraph ×1/);
  assert.equal(repeatedMutation, false);
  assert.match(observedModelText, /STYLE_NOT_FOUND/);
  assert.match(observedModelText, /Current document ID: none; current version: none/);
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

test('explicit learn-style request binds the open saved version and exposes the product capability', async () => {
  const persistence = memoryPersistence('user-1');
  const binding = await createNapiDocxEngineBinding();
  const documentId = '00000000-0000-4000-8000-000000000001';
  const versionId = '00000000-0000-4000-8000-000000000002';
  const bytes = Buffer.from(buildMinimalDocx(['A report']));
  const document = { id: documentId, workspaceId: 'ws-1', name: 'Report.docx', format: 'docx', latestVersion: { id: versionId } };
  let learned = 0;
  const deps = baseDeps(persistence, async input => {
    const initialTools = await input.projectTools!({ turn: 1 } as never);
    assert.equal(initialTools['style.learn_from_document'], undefined);
    await input.tools!['capabilities.load']!.execute!({ ids: ['style.learn_from_document'] }, {} as never);
    const tools = await input.projectTools!({ turn: 2 } as never);
    assert.ok(tools['style.learn_from_document']);
    await tools['style.learn_from_document']!.execute!({ name: 'Blue Harbor Operating Report Style' }, {} as never);
    return softResult('completed', 'Style saved.');
  });
  const execution = createAgentExecutionService({ ...deps, docxBinding: binding,
    documents: { ...deps.documents, getOwnedDocument: async () => document as never, listInWorkspace: async () => [document] as never, readExactVersionBytes: async () => bytes },
    styleProfiles: { learnFromDocument: async (input: { documentId: string; versionId?: string }) => {
      learned++;
      assert.equal(input.documentId, documentId);
      assert.equal(input.versionId, versionId);
      const { normalizeStyleSnapshot } = await import('../style-profiles/normalize.js');
      return { id: documentId, name: 'Report Style', createdAt: '', updatedAt: '', source: { type: 'docx', documentId, versionId, workspaceId: 'ws-1', fileName: 'Report.docx', extractedAt: '', snapshotSchemaVersion: 1, normalizerVersion: 1 }, style: normalizeStyleSnapshot(await binding.inspectDocxStyleSnapshot(bytes)) };
    } } as never,
  });
  const result = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', activeDocumentId: documentId, instruction: 'Learn the document style from this document and save it for future use.' })).result;
  assert.equal(result.run.status, 'completed');
  assert.equal(learned, 1);
  assert.equal(result.run.baseDocumentVersionId, versionId);
});

test('saved-style completion cannot succeed from assistant text or generic guidance alone', async () => {
  const persistence = memoryPersistence('user-1');
  const deps = baseDeps(persistence, async () => softResult('completed', 'I used your saved Resume Style.'));
  const execution = createAgentExecutionService(deps);
  const result = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Use my Resume Style and build me a resume.' })).result;
  assert.equal(result.run.status, 'failed');
  assert.match(result.run.errorMessage ?? '', /saved style was not applied and verified/);
  assert.equal(result.assistantMessage, null);
});

test("partial successful edits cannot present full-success completion", async () => {
  const binding = await createNapiDocxEngineBinding();
  const persistence = memoryPersistence("user-1");
  let bytes = Buffer.from(buildMinimalDocx(["Start"]));
  let versionId = "v1";
  let appends = 0;
  const reports: AgentRunReport[] = [];
  const deps = baseDeps(persistence, async (input) => {
    const call = { toolCallId: "test", messages: [], context: undefined as never };
    assert.equal((await input.tools!["document.insert_paragraph"]!.execute!({ text: "Kept edit", placement: { kind: "end" } }, call) as { ok: boolean }).ok, true);
    const base = softResult("finish_tool", "All done");
    return {
      ...base,
      metrics: {
        ...base.metrics,
        toolCalls: [
          { sequence: 1, turn: 1, toolName: "document.insert_paragraph", kind: "mutate", durationMs: 1, outcome: "success" },
          { sequence: 2, turn: 1, toolName: "document.set_table_cells_text", kind: "mutate", durationMs: 1, outcome: "failure", failureCode: "TABLE_NOT_FOUND" },
        ],
      },
    };
  });
  const execution = createAgentExecutionService({
    ...deps,
    docxBinding: binding,
    agentRunReportSink: (report) => { reports.push(report); },
    documents: {
      ...deps.documents,
      getOwnedDocument: async () => ({ id: "doc-1", workspaceId: "ws-1", format: "docx", latestVersion: { id: versionId } }) as never,
      readExactVersionBytes: async () => bytes,
      appendDocumentVersion: async (input) => {
        appends++;
        bytes = Buffer.from(input.bytes);
        versionId = "v2";
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
    },
  });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Edit this document" })).result;
  assert.equal(appends, 1);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
  assert.match(result.assistantMessage?.content ?? "", /partially/i);
  assert.match(result.assistantMessage?.content ?? "", /set_table_cells_text/);
  assert.equal(reports[0]?.outcome, "partial");
  assert.equal(persistence.steps.some((step) => step.kind === "validation"), true);
});

test("failed mutations with no output do not persist a version", async () => {
  const binding = await createNapiDocxEngineBinding();
  const persistence = memoryPersistence("user-1");
  let appends = 0;
  const reports: AgentRunReport[] = [];
  const deps = baseDeps(persistence, async () => {
    const base = softResult("finish_tool", "Done");
    return {
      ...base,
      metrics: {
        ...base.metrics,
        toolCalls: [
          { sequence: 1, turn: 1, toolName: "document.delete_table_row", kind: "mutate", durationMs: 1, outcome: "failure", failureCode: "UNSUPPORTED_STRUCTURAL_DELETE" },
        ],
      },
    };
  });
  const execution = createAgentExecutionService({
    ...deps,
    docxBinding: binding,
    agentRunReportSink: (report) => { reports.push(report); },
    documents: {
      ...deps.documents,
      getOwnedDocument: async () => ({ id: "doc-1", workspaceId: "ws-1", format: "docx", latestVersion: { id: "v1" } }) as never,
      readExactVersionBytes: async () => Buffer.from(buildMinimalDocx(["Start"])),
      appendDocumentVersion: async () => {
        appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
    },
  });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Delete the protected row" })).result;
  assert.equal(appends, 0);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_MUTATION_FAILED");
  assert.equal(reports[0]?.outcome, "failure");
  assert.equal(reports[0]?.document?.versionAdvances.length ?? 0, 0);
});
