import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent, type RunAgentResult, type RunModelResult, type AgentModel } from "@opensuite/agent-core";
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
      let bodyHandle = "invalid";
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
        if (current === 1) {
          const results = options.prompt.filter(message => message.role === "tool").flatMap(message => message.content).filter(part => part.type === "tool-result");
          const inspected = results.find(part => part.toolName === "document_inspect");
          assert.ok(inspected);
          const result = JSON.stringify(inspected).match(/"handle":"([^"\s]+:b0)"/);
          assert.ok(result);
          bodyHandle = result[1]!;
        }
        const calls = [
          [{ name: "document_inspect", input: { kind: "body_blocks" } },
            ...[["First", "One"], ["Second", "Two"], ["Third", "Three"]].map(([text, replacement]) => ({ name: "document_replace_text", input: { target: { text }, expectedCurrentText: text, replacement } }))],
          [{ name: "document_insert_paragraphs", input: { texts: ["Inserted"], placement: { kind: "before", handle: bodyHandle } } },
            { name: "document_find", input: { text: "One" } }],
          [{ name: "document_inspect", input: { kind: "body_blocks" } },
            { name: "document_insert_paragraphs", input: { texts: ["Inserted"], placement: { kind: "start" } } }],
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
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION", "a changed insertion target cannot prove recovery");
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
  steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null; output?: Record<string, unknown> }[];
  failOnStatus?: AgentRun["status"];
} {
  const thread = stubThread(ownerUserId);
  const messages: AgentMessage[] = [];
  const runs = new Map<string, AgentRun>();
  const steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null; output?: Record<string, unknown> }[] = [];
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
    async appendSteps(input: { runId: string; steps: { runId?: string; sequence: number; kind: string; status: string; name: string; summary?: string | null; output?: Record<string, unknown> }[] }) {
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
    steps: { runId: string; sequence: number; kind: string; status: string; name: string; summary?: string | null; output?: Record<string, unknown> }[];
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
      model: { provider: "test", modelId: "test" } as unknown as AgentModel,
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

test("successful agent-core finish_tool settles completed + agent.completed", async () => {
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
  const reports: AgentRunReport[] = [];
  const execution = createAgentExecutionService({ ...baseDeps(persistence, async (input) => {
    assert.ok(input.tools?.finish_with_input_needed);
    await input.onEvent?.({ type: "text_delta", delta: "KPIs updated. Budget unchanged; new budget figures are needed." });
    await input.onEvent?.({ type: "tool_started", toolCallId: "finish-1", toolName: "finish_with_input_needed" });
    await input.tools.finish_with_input_needed.execute!({ missingInformation: "New budget figures" }, { toolCallId: "finish-1", messages: [], context: undefined as never });
    await input.onEvent?.({ type: "tool_completed", toolCallId: "finish-1", toolName: "finish_with_input_needed" });
    const result = softResult("finish_tool", "KPIs updated. Budget unchanged; new budget figures are needed.");
    return { ...result, metrics: { ...result.metrics, toolCalls: [{ sequence: 0, turn: 1, toolName: "finish_with_input_needed", kind: "read", durationMs: 0, outcome: "success" }] } };
  }), agentRunReportSink: (report) => { reports.push(report); } });
  const result = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Update KPIs and budget" })).result;
  assert.equal(result.run.status, "completed_with_input_needed");
  assert.equal(result.run.errorCode, null);
  assert.equal(reports[0]?.outcome, "partial");
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
    docxBinding: await createNapiDocxEngineBinding(),
    resolveModel: async () => ({ model: { provider: "test", modelId: "test" } as unknown as AgentModel,
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

test("provider credit and rate-limit errors map to safe copy without leaking key URLs", () => {
  const openRouterCredits = new Error(
    "This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 61655. To increase, visit https://openrouter.ai/workspaces/default/keys/secretkey and adjust the key's total limit",
  );
  assert.deepEqual(describeRunFailure(openRouterCredits, []), {
    code: "MODEL_PROVIDER_CREDITS",
    message:
      "The AI provider doesn't have enough credits for this request. Add credits or raise the key limit, then try again.",
  });
  assert.doesNotMatch(
    describeRunFailure(openRouterCredits, [])?.message ?? "",
    /openrouter\.ai|secretkey|api.?key/i,
  );

  assert.deepEqual(
    describeRunFailure(
      new Error(
        "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
      ),
      [],
    ),
    {
      code: "MODEL_PROVIDER_IN_FLIGHT_BUDGET",
      message:
        "The AI provider is temporarily holding other in-flight requests against your credits. Please wait a minute and try again.",
    },
  );

  assert.deepEqual(
    describeRunFailure(
      new Error(
        "deepseek/deepseek-v4.1-flash is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
      ),
      [],
    ),
    {
      code: "MODEL_PROVIDER_RATE_LIMITED",
      message: "The AI provider is temporarily rate-limited. Please try again shortly.",
    },
  );
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

test("successful agent-core completed (no tools) settles completed", async () => {
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

test("named targets and explicit current-document requests bind before model selection", async () => {
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
  assert.equal(named.run.baseDocumentVersionId, "v-board");
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
  assert.equal(result.run.baseDocumentVersionId, "target-v1");
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
    model: { provider: "test", modelId: "test" } as unknown as AgentModel,
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
    model: { provider: "test", modelId: "test" } as unknown as AgentModel,
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
      model: { provider: "test", modelId: "test" } as unknown as AgentModel,
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
    documentIds: ["source-1", "source-2"],
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
  assert.ok(persistence.workingDocumentIds.includes("source-1"), "Continue retains the original attachment reference");
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

test("event relay maps agent-core tool_skipped onto product tool.failed", async () => {
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

interface ScriptedTurn {
  readonly text?: string;
  readonly reasoning?: string;
  readonly calls: readonly { readonly name: string; readonly input: unknown }[];
  /** Model call throws instead of answering; "abort" cancels the run first. */
  readonly fail?: "error" | "abort";
}

/** Real agent-core loop + real native engine; only the model is scripted. */
async function runScriptedDocx(input: {
  readonly bytes: Buffer;
  readonly turns: readonly (ScriptedTurn | ((prompt: unknown) => ScriptedTurn))[];
  readonly instruction: string;
  readonly binding?: Awaited<ReturnType<typeof createNapiDocxEngineBinding>>;
  /** Bill as managed OpenRouter; the hook runs once per debit. */
  readonly managedDebit?: (event: { id: string }) => Promise<void>;
  readonly unreadableSavedVersion?: boolean;
}) {
  const binding = input.binding ?? await createNapiDocxEngineBinding();
  const persistence = memoryPersistence("user-1");
  const controller = new AbortController();
  const state = {
    bytes: input.bytes,
    versions: new Map([["v1", Buffer.from(input.bytes)]]),
    versionId: "v1",
    appends: 0,
    exposedTools: [] as string[][],
    estimatedModelInputTokens: 0,
    modelInputs: [] as string[],
    peakModelInputTokens: 0,
    runtime: undefined as RunAgentResult | undefined,
    reports: [] as AgentRunReport[],
    usage: [] as { agentRunId?: string | null; inputTokens?: number }[],
    debits: [] as string[],
    events: [] as AgentEvent[],
    persistence,
  };
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    state.exposedTools.push(options.tools?.map((tool) => tool.name) ?? []);
    const inputTokens = estimateTokens(JSON.stringify({ prompt: options.prompt, tools: options.tools }));
    state.estimatedModelInputTokens += inputTokens;
    state.peakModelInputTokens = Math.max(state.peakModelInputTokens, inputTokens);
    state.modelInputs.push(JSON.stringify(options.prompt));
    const scripted = input.turns[turn++] ?? { calls: [] };
    const current = typeof scripted === "function" ? scripted(options.prompt) : scripted;
    if (current.fail === "abort") controller.abort(new Error("cancelled by user"));
    if (current.fail) throw new Error("provider unavailable");
    const finishReason = (current.calls.length ? "tool-calls" : "stop") as "tool-calls" | "stop";
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(current.reasoning ? [
        { type: "reasoning-start" as const, id: "reason" },
        { type: "reasoning-delta" as const, id: "reason", delta: current.reasoning },
        { type: "reasoning-end" as const, id: "reason" },
      ] : []),
      ...(current.text ? [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: current.text },
        { type: "text-end" as const, id: "text" },
      ] : []),
      ...current.calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
      { type: "finish" as const, finishReason: { unified: finishReason, raw: finishReason },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  const deps = baseDeps(persistence, async (agentInput) => {
    state.runtime = await runAgent({ ...agentInput, model });
    return state.runtime;
  });
  const execution = createAgentExecutionService({
    ...deps,
    docxBinding: binding,
    agentRunReportSink: (report) => { state.reports.push(report); },
    resolveModel: async (userId) => ({ ...await deps.resolveModel(userId), usageAttribution: input.managedDebit
      ? { provider: "openrouter", model: "scripted", credentialSource: "managed" }
      : { provider: "openai", model: "scripted", credentialSource: "byok" } }),
    modelUsage: { recordFromProviderResponse: async ({ attribution, usage }: { attribution: { agentRunId?: string | null }; usage?: { inputTokens?: number } }) => {
      state.usage.push({ agentRunId: attribution.agentRunId, inputTokens: usage?.inputTokens });
      return { id: `usage-${state.usage.length}` } as never;
    } } as never,
    ...(input.managedDebit ? { managedUsagePolicy: {
      beforeManagedCall: async () => {},
      afterUsageRecorded: async (event: { id: string }) => { state.debits.push(event.id); await input.managedDebit!(event); },
      status: async () => { throw new Error("unused"); },
    } } : {}),
    documents: {
      ...deps.documents,
      getOwnedDocument: async () => ({ id: "doc-1", name: "Roster.docx", workspaceId: "ws-1", format: "docx", latestVersion: { id: state.versionId } }) as never,
      readExactVersionBytes: async ({ versionId }) => {
        if (input.unreadableSavedVersion && versionId === "v2") throw new Error("object storage unavailable");
        const bytes = state.versions.get(versionId);
        if (!bytes) throw new Error("version not found");
        return bytes;
      },
      appendDocumentVersion: async (append) => {
        assert.equal(append.baseVersionId, state.versionId);
        state.bytes = Buffer.from(append.bytes);
        state.versionId = `v${state.appends + 2}`;
        state.versions.set(state.versionId, Buffer.from(append.bytes));
        state.appends++;
        return { version: { id: state.versionId, versionNumber: state.appends + 1 } } as never;
      },
    },
  });
  const result = await (await execution.start({
    userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: input.instruction,
    signal: controller.signal, liveEvents: { emit: (event) => { state.events.push(event); } },
  })).result;
  return { binding, result, state, execution };
}

async function rosterTableDocx(): Promise<Buffer> {
  const seed = bindDocxDocument({ binding: await createNapiDocxEngineBinding(), bytes: buildMinimalDocx(["Team roster"]) });
  assert.equal((await seed.mutate("create_table", { rows: rosterRows, placement: { kind: "end" } })).ok, true);
  return Buffer.from(seed.currentBytes());
}

const rosterRows = [["Name", "Role"], ["Ada", "CEO"], ["Lin", "CTO"]];
const rosterTable = { headerCells: ["Name", "Role"] };
const headerCell = (column: unknown) => ({ row: { kind: "header" }, column });

test("semantic header bold + shading runs through the real loop: dynamic load, one save, reopened output", async () => {
  const { binding, result, state } = await runScriptedDocx({
    bytes: Buffer.from(buildMinimalDocx(["Team roster"])),
    instruction: "Update this document: add a roster table with a bold, shaded header row.",
    turns: [
      { calls: [
        { name: "document_create_table", input: { rows: rosterRows, placement: { kind: "end" } } },
        { name: "capabilities_load", input: { ids: ["document.tables.styling"] } },
      ] },
      { calls: [
        { name: "document_set_table_cells_formatting", input: { table: rosterTable, updates: [
          { target: headerCell({ kind: "first" }), textFormatting: { bold: true } },
          { target: headerCell({ kind: "header", text: "Role" }), textFormatting: { bold: true } },
        ] } },
        { name: "document_set_table_cell_shading", input: { table: rosterTable, updates: [
          { target: headerCell({ kind: "first" }), fill: "D9E2F3" },
          { target: headerCell({ kind: "header", text: "Role" }), fill: "D9E2F3" },
        ] } },
      ] },
      { text: "Added the roster table with a bold, shaded header.", calls: [{ name: "finish", input: {} }] },
    ],
  });

  assert.equal(result.run.status, "completed", result.run.errorMessage ?? "");
  assert.equal(result.assistantMessage?.content, "Added the roster table with a bold, shaded header.");
  assert.equal(state.appends, 1);
  assert.equal(state.exposedTools[0]!.includes("document_set_table_cells_formatting"), false);
  assert.equal(state.exposedTools[1]!.includes("document_set_table_cells_formatting"), true);
  assert.equal(state.exposedTools[1]!.includes("document_set_table_cell_shading"), true);
  assert.deepEqual(state.runtime!.metrics.toolCalls.map((call) => [call.toolName, call.outcome]), [
    ["capabilities.load", "success"],
    ["document.create_table", "success"],
    ["document.set_table_cells_formatting", "success"],
    ["document.set_table_cell_shading", "success"],
    ["finish", "success"],
  ]);
  assert.equal(state.reports[0]?.outcome, "success");

  const saved = new Uint8Array(state.bytes);
  const tables = await binding.inspectDocx(saved, { focus: { kind: "tables" } });
  assert.deepEqual(tables.tables?.items?.[0]?.rows.map((row) => row.cells), rosterRows);
  const snapshot = await inspectDocxStyleSnapshot(saved, binding);
  assert.deepEqual(snapshot.tables[0]?.firstRowShadingColors, ["D9E2F3"]);
  assert.equal(snapshot.tables[0]?.shadingColors.find((color) => color.value === "D9E2F3")?.count, 2);
  assert.ok((snapshot.tables[0]?.firstRowBoldRunCount ?? 0) >= 2);
});

test("a failed semantic cell edit after a successful edit saves the edit but settles as partial", async () => {
  const { binding, result, state } = await runScriptedDocx({
    bytes: Buffer.from(buildMinimalDocx(["Team roster"])),
    instruction: "Update this document: add a roster table and shade the Status header.",
    turns: [
      { calls: [
        { name: "document_create_table", input: { rows: rosterRows, placement: { kind: "end" } } },
        { name: "capabilities_load", input: { ids: ["document.tables.styling"] } },
      ] },
      { calls: [{ name: "document_set_table_cell_shading", input: { table: rosterTable, updates: [
        { target: headerCell({ kind: "header", text: "Status" }), fill: "D9E2F3" },
      ] } }] },
      { text: "Added the table and shaded the header.", calls: [{ name: "finish", input: {} }] },
    ],
  });

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
  assert.match(result.assistantMessage?.content ?? "", /set_table_cell_shading/);
  assert.equal(state.appends, 1);
  assert.equal(state.reports[0]?.outcome, "partial");
  assert.deepEqual(state.usage, [{ agentRunId: result.run.id, inputTokens: 3 }], "partial runs record usage exactly once");
  const shading = state.runtime!.metrics.toolCalls.find((call) => call.toolName === "document.set_table_cell_shading");
  assert.equal(shading?.outcome, "failure");
  assert.equal(shading?.failureCode, "TABLE_COLUMN_NOT_FOUND", "semantic targets must reach the engine");

  const saved = new Uint8Array(state.bytes);
  const tables = await binding.inspectDocx(saved, { focus: { kind: "tables" } });
  assert.deepEqual(tables.tables?.items?.[0]?.rows.map((row) => row.cells), rosterRows);
  assert.deepEqual((await inspectDocxStyleSnapshot(saved, binding)).tables[0]?.firstRowShadingColors, []);
});

test("a failed semantic cell edit with no other edit saves nothing and fails the run", async () => {
  const { result, state } = await runScriptedDocx({
    bytes: await rosterTableDocx(),
    instruction: "Format this document: bold the Status header in the roster table.",
    turns: [
      { calls: [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }] },
      { calls: [{ name: "document_set_table_cells_formatting", input: { table: rosterTable, updates: [
        { target: headerCell({ kind: "header", text: "Status" }), textFormatting: { bold: true } },
      ] } }] },
      { text: "Bolded the header.", calls: [{ name: "finish", input: {} }] },
    ],
  });

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_MUTATION_FAILED");
  assert.equal(state.appends, 0);
  assert.equal(state.reports[0]?.outcome, "failure");
  assert.equal(
    state.runtime!.metrics.toolCalls.find((call) => call.toolName === "document.set_table_cells_formatting")?.failureCode,
    "TABLE_COLUMN_NOT_FOUND",
  );
});

test("semantic row deletion through the real loop removes the labelled row and saves once", async () => {
  const { binding, result, state } = await runScriptedDocx({
    bytes: await rosterTableDocx(),
    instruction: "Edit this document: remove Lin from the roster table.",
    turns: [
      { calls: [{ name: "document_delete_table_row", input: { table: rosterTable, row: { kind: "label", text: "Lin" } } }] },
      { text: "Removed Lin from the roster.", calls: [{ name: "finish", input: {} }] },
    ],
  });

  assert.equal(result.run.status, "completed", result.run.errorMessage ?? "");
  assert.equal(state.appends, 1);
  const tables = await binding.inspectDocx(new Uint8Array(state.bytes), { focus: { kind: "tables" } });
  assert.deepEqual(tables.tables?.items?.[0]?.rows.map((row) => row.cells), rosterRows.slice(0, 2));
});

test("an empty no-tool final response does not settle earlier narration as the reply", async () => {
  const narration = "Let me update the roster heading.";
  const { result, state } = await runScriptedDocx({
    bytes: Buffer.from(buildMinimalDocx(["Team roster"])),
    instruction: "Edit this document: rename the heading to Team list.",
    turns: [
      { text: narration, calls: [{ name: "document_replace_text", input: { target: { text: "Team roster" }, expectedCurrentText: "Team roster", replacement: "Team list" } }] },
      { calls: [] },
    ],
  });

  assert.equal(state.appends, 1);
  assert.equal(result.run.status, "completed");
  assert.match(result.assistantMessage?.content ?? "", /^Saved the changes to /);
});

test("a later success on a different cell does not recover an earlier failed cell edit", async () => {
  const { result, state } = await runScriptedDocx({
    bytes: await rosterTableDocx(),
    instruction: "Update this document: in the roster, set Sam's role to CFO and Ada's role to Founder.",
    turns: [
      { calls: [{ name: "document_set_table_cells_text", input: { table: rosterTable, updates: [{
        target: { row: { kind: "label", text: "Sam" }, column: { kind: "header", text: "Role" } }, expectedCurrentText: "CFO", replacement: "CFO",
      }] } }] },
      { calls: [{ name: "document_set_table_cells_text", input: { table: rosterTable, updates: [{
        target: { row: { kind: "label", text: "Ada" }, column: { kind: "header", text: "Role" } }, expectedCurrentText: "CEO", replacement: "Founder",
      }] } }] },
      { text: "Updated both roles.", calls: [{ name: "finish", input: {} }] },
    ],
  });

  assert.equal(state.appends, 1);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
});

test("the same formatting on another cell cannot hide unfinished work", async () => {
  const formatting = (row: string) => ({ table: rosterTable, updates: [{
    target: { row: { kind: "label", text: row }, column: { kind: "header", text: "Role" } },
    textFormatting: { bold: true },
  }] });
  const original = await rosterTableDocx();
  const { binding, result, state } = await runScriptedDocx({
    bytes: original,
    instruction: "Update this document: bold Sam's and Ada's roles.",
    turns: [
      { calls: [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }] },
      { calls: [{ name: "document_set_table_cells_formatting", input: formatting("Sam") }] },
      { calls: [{ name: "document_set_table_cells_formatting", input: formatting("Ada") }] },
      { text: "Bolded both roles.", calls: [{ name: "finish", input: {} }] },
    ],
  });
  assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
  assert.match(result.assistantMessage?.content ?? "", /partially[\s\S]*set_table_cells_formatting/);
  assert.notEqual(result.assistantMessage?.content, "Bolded both roles.");
  assert.equal(state.appends, 1);
  assert.equal(state.reports[0]?.outcome, "partial");
  assert.equal(state.reports[0]?.tools.find(tool => tool.outcome === "failure")?.recovered, false);
  assert.deepEqual(state.versions.get("v1"), original);
  const snapshot = await inspectDocxStyleSnapshot(state.bytes, binding);
  assert.ok(snapshot.typography.boldRunCount > 0);
  assert.equal((await inspectDocxStyleSnapshot(original, binding)).typography.boldRunCount, 0);
});

test("only the same requested replacement clears a failed edit through the real loop", async () => {
  for (const replacement of ["Team list", "Team LIST", "Team  list"]) {
    const { binding, result, state } = await runScriptedDocx({
      bytes: buildMinimalDocx(["Team roster"]),
      instruction: "Update this document: replace Team roster with Team list.",
      turns: [
        { calls: [{ name: "document_replace_text", input: { target: { text: "Team roster" }, expectedCurrentText: "Wrong guard", replacement: "Team list" } }] },
        { calls: [{ name: "document_replace_text", input: { target: { text: "Team roster" }, expectedCurrentText: "Team roster", replacement } }] },
        { text: "Updated the heading.", calls: [{ name: "finish", input: {} }] },
      ],
    });
    const recovered = replacement === "Team list";
    assert.equal(result.run.status, recovered ? "completed" : "failed", replacement);
    assert.equal(result.run.errorCode, recovered ? null : "AGENT_PARTIAL_COMPLETION", replacement);
    assert.equal(state.reports[0]?.outcome, recovered ? "success" : "partial", replacement);
    assert.equal(state.reports[0]?.tools.find(tool => tool.outcome === "failure")?.recovered, recovered);
    assert.equal(state.appends, 1);
    const before = await binding.findDocxText(state.versions.get("v1")!, { text: "Team roster" });
    const after = await binding.findDocxText(state.bytes, { text: replacement });
    assert.equal(before.matchCount, 1);
    assert.equal(after.matchCount, 1);
  }
});

test("every terminal path bills once, debits once, and settles a truthful durable status and history", async () => {
  const edit: ScriptedTurn = { calls: [{ name: "document_replace_text", input: { target: { text: "Team roster" }, expectedCurrentText: "Team roster", replacement: "Team list" } }] };
  const finish: ScriptedTurn = { text: "Renamed the heading.", calls: [{ name: "finish", input: {} }] };
  const modelError: ScriptedTurn = { calls: [], fail: "error" };
  const debitOk = async () => {};
  const exhausted = async () => { throw Object.assign(new Error("Managed AI is unavailable."), { code: "MANAGED_USAGE_EXHAUSTED" }); };
  const cases: readonly {
    readonly name: string;
    readonly turns: readonly (ScriptedTurn | ((prompt: unknown) => ScriptedTurn))[];
    readonly managedDebit?: (event: { id: string }) => Promise<void>;
    readonly unreadableSavedVersion?: boolean;
    readonly status: AgentRun["status"];
    readonly code: string | null;
    /** Summed input tokens of the one usage event, or null for no event. */
    readonly billedTokens: number | null;
    readonly saved: boolean;
    readonly report: AgentRunReport["outcome"];
    readonly reply?: RegExp;
  }[] = [
    { name: "success", turns: [edit, finish], managedDebit: debitOk, status: "completed", code: null, billedTokens: 2, saved: true, report: "success", reply: /^Renamed the heading\.$/ },
    { name: "model error after a saved edit", turns: [edit, modelError], managedDebit: debitOk, status: "failed", code: "AGENT_EXECUTION_FAILED", billedTokens: 1, saved: true, report: "partial" },
    { name: "model error before any work", turns: [modelError], managedDebit: debitOk, status: "failed", code: "AGENT_EXECUTION_FAILED", billedTokens: null, saved: false, report: "failure" },
    { name: "cancellation after an edit", turns: [edit, { calls: [], fail: "abort" }], managedDebit: debitOk, status: "cancelled", code: null, billedTokens: 1, saved: true, report: "cancelled" },
    { name: "failed verification", turns: [edit, finish], unreadableSavedVersion: true, status: "failed", code: "DOCUMENT_VERIFICATION_FAILED", billedTokens: 2, saved: true, report: "partial", reply: /could not be verified[\s\S]*preserved/ },
    { name: "managed credit failure after saved work", turns: [edit, finish], managedDebit: exhausted, status: "failed", code: "MANAGED_USAGE_EXHAUSTED", billedTokens: 2, saved: true, report: "partial" },
    { name: "credit failure does not mask a model error", turns: [edit, modelError], managedDebit: exhausted, status: "failed", code: "AGENT_EXECUTION_FAILED", billedTokens: 1, saved: true, report: "partial" },
  ];

  for (const item of cases) {
    const { result, state } = await runScriptedDocx({
      bytes: Buffer.from(buildMinimalDocx(["Team roster"])),
      instruction: "Edit this document: rename the heading to Team list.",
      turns: item.turns,
      ...(item.managedDebit ? { managedDebit: item.managedDebit } : {}),
      ...(item.unreadableSavedVersion ? { unreadableSavedVersion: true } : {}),
    });
    const durable = state.persistence.runs.get(result.run.id)!;
    assert.equal(durable.status, item.status, `${item.name}: ${durable.errorMessage ?? ""}`);
    assert.equal(durable.errorCode, item.code, item.name);
    assert.equal(result.run.status, durable.status, `${item.name}: returned run matches durable run`);

    assert.deepEqual(state.usage, item.billedTokens === null ? [] : [{ agentRunId: result.run.id, inputTokens: item.billedTokens }], `${item.name}: one usage event`);
    if (item.managedDebit) assert.deepEqual(state.debits, state.usage.map((_, index) => `usage-${index + 1}`), `${item.name}: one debit per usage event`);

    assert.equal(state.appends, item.saved ? 1 : 0, item.name);
    assert.equal(state.events.filter((event) => event.type === "document.version.advanced").length, item.saved ? 1 : 0, item.name);
    const terminal = state.events.filter((event) => event.type === "agent.completed" || event.type === "agent.failed" || event.type === "agent.cancelled");
    assert.deepEqual(terminal.map((event) => [event.type, event.type === "agent.failed" ? event.code : null]),
      [[item.status === "completed" ? "agent.completed" : item.status === "cancelled" ? "agent.cancelled" : "agent.failed", item.code]], `${item.name}: one terminal event`);
    assert.deepEqual(state.reports.map((report) => report.outcome), [item.report], `${item.name}: one report`);

    const assistant = state.persistence.messages.filter((message) => message.role === "assistant");
    if (item.reply) {
      assert.equal(assistant.length, 1, item.name);
      assert.match(assistant[0]!.content, item.reply, item.name);
      assert.equal(durable.resultMessageId, assistant[0]!.id, item.name);
    } else assert.equal(assistant.length, 0, item.name);
    if (item.status === "failed" && item.saved) {
      assert.match(durable.errorMessage ?? "", /Changes made so far were preserved\./, `${item.name}: a failed run that saved says so`);
    }
    if (!item.saved) assert.doesNotMatch(durable.errorMessage ?? "", /preserved/, item.name);

    const history = await loadHistory({ persistence: state.persistence, threadId: "thread-1", ownerUserId: "user-1", excludeMessageId: "next" });
    const prior = history.priorMessages.map((message) => message.content).join("\n");
    assert.match(prior, new RegExp(`status: ${item.status}`), item.name);
    if (item.saved) assert.match(prior, /tools used: [^\n]*document\.replace_text/, `${item.name}: next turn knows the edit happened`);
    if (item.status === "failed" && item.saved) assert.match(prior, /preserved/, `${item.name}: next turn knows the edit was kept`);
  }
});

test("Northstar table edit activates before the real model loop without initial search or selection", async () => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Business Impact and KPI Targets"]) });
  assert.equal((await seed.mutate("create_table", { placement: { kind: "end" }, rows: [
    ["Metric", "Target After Deployment"], ["Mean Time to Detect", "15 minutes"], ["Availability", "99.9%"],
  ] })).ok, true);
  const original = Buffer.from(seed.currentBytes());
  for (const target of ["tagged", "open", "named"] as const) {
    const persistence = memoryPersistence("user-1");
    let saved = original;
    let versionId = "v1";
    let appends = 0;
    let workspaceReads = 0;
    let activeBeforeModel = false;
    let turn = 0;
    let runtime: RunAgentResult | undefined;
    const edit = { name: "document_set_table_cells_text", input: {
      table: { headerCells: ["Metric", "Target After Deployment"] }, updates: [{
        target: { row: { kind: "label", text: "Mean Time to Detect" }, column: { kind: "header", text: "Target After Deployment" } },
        expectedCurrentText: "15 minutes", replacement: "10 minutes",
      }],
    } };
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      if (!turn) activeBeforeModel = JSON.stringify(options.prompt[0]).includes("Active document ID: target");
      const calls = activeBeforeModel ? [edit, { name: "finish", input: {} }] : [
        { name: "document_inspect", input: { kind: "tables" } },
        { name: "workspace_search_documents", input: { query: "Northstar" } },
        { name: "workspace_select_document", input: { documentId: "target" } }, edit, { name: "finish", input: {} },
      ];
      const call = calls[turn++]!;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: `edit-${turn}`, toolName: call.name, input: JSON.stringify(call.input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 },
        } },
      ] as never[] }) };
    } });
    const deps = baseDeps(persistence, async (input) => { runtime = await runAgent({ ...input, model }); return runtime; }, undefined, 128_000);
    const document = () => ({ id: "target", name: "Northstar deployment report.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: versionId, versionNumber: appends + 1 } });
    const source = { id: "source", name: "Unrelated context.docx", format: "docx", workspaceId: "ws-1", latestVersion: { id: "source-v1", versionNumber: 1 } };
    const execution = createAgentExecutionService({ ...deps, docxBinding: binding, documents: { ...deps.documents,
      listInWorkspace: async () => { workspaceReads++; return [document(), source] as never; },
      getOwnedDocument: async ({ documentId }) => {
        if (documentId === "target") return document() as never;
        if (documentId === "source") return source as never;
        throw new Error("missing");
      },
      readExactVersionBytes: async ({ documentId, versionId: requested }) => {
        if (documentId === "source") return Buffer.from(buildMinimalDocx(["Reference only"]));
        return requested === "v1" ? original : saved;
      },
      appendDocumentVersion: async ({ documentId, baseVersionId, bytes }) => {
        assert.equal(documentId, "target"); assert.equal(baseVersionId, "v1");
        saved = Buffer.from(bytes); versionId = "v2"; appends++;
        return { version: { id: versionId, versionNumber: 2 } } as never;
      },
    } });
    const instruction = 'In the "Business Impact and KPI Targets" table, update the "Target After Deployment" value for "Mean Time to Detect" from "15 minutes" to "10 minutes".';
    const result = await (await execution.start({ userId: "user-1", threadId: "thread-1",
      instruction: target === "named" ? `Update Northstar deployment report: ${instruction}` : instruction,
      ...(target === "open" ? { activeDocumentId: "target" } : {}),
      ...(target === "tagged" ? { documentIds: ["target"] } : {}),
    })).result;
    const calls = runtime!.metrics.toolCalls;
    const measurement = { target, activeBeforeModel,
      searches: calls.filter((call) => call.toolName === "workspace.search_documents").length,
      selections: calls.filter((call) => call.toolName === "workspace.select_document").length,
      missingTargetErrors: calls.filter((call) => call.failureCode === "NO_ACTIVE_DOCUMENT").length,
      recoveryTurns: activeBeforeModel ? 0 : calls.filter((call) => ["document.inspect", "workspace.search_documents", "workspace.select_document"].includes(call.toolName)).length,
    };
    console.info(`PHASE1_MEASUREMENT ${JSON.stringify(measurement)}`);
    assert.equal(activeBeforeModel, true);
    assert.equal(measurement.searches + measurement.selections + measurement.missingTargetErrors + measurement.recoveryTurns, 0);
    assert.equal(workspaceReads, 1, "target resolution reuses the manifest query");
    assert.equal(result.run.status, "completed"); assert.equal(result.run.baseDocumentVersionId, "v1");
    assert.equal(appends, 1);
    const inspected = await binding.inspectDocx(saved, { focus: { kind: "tables" } });
    assert.match(JSON.stringify(inspected), /10 minutes/); assert.doesNotMatch(JSON.stringify(inspected), /15 minutes/);
    assert.match(JSON.stringify(inspected), /99.9%/);
  }
});

test("Continue restores a switched target from saved steps and validates it again", async () => {
  const persistence = memoryPersistence("user-1");
  const binding = await createNapiDocxEngineBinding();
  const bytes = Buffer.from(buildMinimalDocx(["Continue here"]));
  const documents = ["first", "second"].map((id) => ({ id, name: `${id}.docx`, format: "docx", workspaceId: "ws-1", latestVersion: { id: `${id}-v1` } }));
  let continuing = false;
  let missing = false;
  let modelCalls = 0;
  const deps = baseDeps(persistence, async (input) => {
    modelCalls++;
    const call = { toolCallId: "switch", messages: [], context: undefined as never };
    if (!continuing) {
      await input.tools!["capabilities.load"]!.execute!({ ids: ["document.set_text_formatting"] }, call);
      assert.equal((await input.tools!["workspace.select_document"]!.execute!({ documentId: "second" }, call) as { ok: boolean }).ok, true);
      await input.onEvent?.({ type: "tool_completed", toolCallId: "switch", toolName: "workspace.select_document" });
      return softResult("max_turns");
    }
    assert.match(input.system ?? "", /Active document ID: second/);
    const tools = input.projectTools!({ tools: input.tools!, turn: 1, messages: input.messages });
    assert.ok(tools["document.set_text_formatting"]);
    assert.equal(tools["document.batch_text_formatting"], undefined);
    assert.match(JSON.stringify(await input.projectMessages!(input.messages)), /Loaded IDs: document.set_text_formatting/);
    assert.match(JSON.stringify(input.messages), /Current document ID: second; current version: second-v1/);
    assert.equal((await input.tools!["document.insert_paragraphs"]!.execute!({ texts: ["Resumed"], placement: { kind: "end" } }, call) as { ok: boolean }).ok, true);
    return softResult("completed", "Done");
  });
  const execution = createAgentExecutionService({ ...deps, docxBinding: binding, documents: { ...deps.documents,
    listInWorkspace: async () => documents as never,
    getOwnedDocument: async ({ documentId }) => {
      if (missing && documentId === "second") throw new Error("deleted");
      return documents.find((document) => document.id === documentId) as never;
    },
    readExactVersionBytes: async () => bytes,
    appendDocumentVersion: async ({ documentId }) => {
      assert.equal(documentId, "second"); return { version: { id: "second-v2", versionNumber: 2 } } as never;
    },
  } });
  const first = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "first", instruction: "Update this document" })).result;
  assert.equal(first.run.errorCode, "AGENT_MAX_TURNS");
  const lastStep = persistence.steps.at(-1)!;
  assert.deepEqual(lastStep.output?.loadedCapabilityIds, ["document.set_text_formatting"]);
  // Old/removed tools and browse-only domains must not prevent valid restoration.
  persistence.steps[persistence.steps.length - 1] = { ...lastStep, output: { ...lastStep.output,
    loadedCapabilityIds: ["document.set_text_formatting", "document.removed_tool", "style.get_profile", "document"] } };
  continuing = true;
  const resume = () => execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "first", instruction: "Continue", continueFromRunId: first.run.id });
  const continued = await (await resume()).result;
  assert.equal(continued.run.baseDocumentVersionId, "second-v1");
  missing = true;
  await assert.rejects(resume(), (error: unknown) => (error as { code: string }).code === "DOCUMENT_NOT_FOUND");
  assert.equal(modelCalls, 2);
});

test("Northstar header formatting recovers the first-column selector and saves verified formatting", async () => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Business Impact and KPI Targets"]) });
  const rows = [["Metric", "Baseline", "Target After Deployment"], ["Mean Time to Detect", "15 minutes", "10 minutes"]];
  assert.equal((await seed.mutate("create_table", { placement: { kind: "end" }, rows })).ok, true);
  const table = { headerCells: rows[0] };
  const update = (column: unknown) => ({ target: { row: { kind: "header" }, column }, fill: "D9E2F3", textFormatting: { bold: true } });
  const { result, state, binding: runtimeBinding } = await runScriptedDocx({
    binding: { ...binding, executeDocxOperation: async (bytes, capability, operation) => {
      if (capability === "set_table_cells_formatting" && ((operation.updates as { target: { column: { kind: string } } }[])[0]?.target.column.kind === "header")) {
        return { result: { ok: false, status: "error", diagnostics: [{ code: "TARGET_NOT_FOUND", reasonCode: "TABLE_COLUMN_NOT_FOUND", severity: "error", message: "Injected selector failure" }], changes: [] } };
      }
      return binding.executeDocxOperation!(bytes, capability, operation);
    } },
    bytes: Buffer.from(seed.currentBytes()), instruction: "Format this document: bold and shade all three KPI table headers.",
    turns: [
      { calls: [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }] },
      { calls: [{ name: "document_set_table_cells_formatting", input: { table, updates: rows[0]!.map(text => update({ kind: "header", text })) } }] },
      { calls: [{ name: "document_set_table_cells_formatting", input: { table, updates: [update({ kind: "first" }), ...rows[0]!.slice(1).map(text => update({ kind: "header", text }))] } }] },
      { text: "Updated and saved the KPI headers.", calls: [{ name: "finish", input: {} }] },
    ],
  });
  const report = state.reports[0]!;
  console.info(`PHASE2_MEASUREMENT ${JSON.stringify({ scenario: "KPI header", outcome: report.outcome, recovered: report.tools.find(tool => tool.outcome === "failure")?.recovered })}`);
  assert.equal(result.run.status, "completed", result.run.errorMessage ?? "");
  assert.equal(report.outcome, "success");
  assert.equal(report.failures[0]?.code, "TABLE_COLUMN_NOT_FOUND");
  assert.equal(report.tools.find(tool => tool.outcome === "failure")?.recovered, true);
  assert.equal(state.appends, 1);
  assert.equal(result.assistantMessage?.content, "Updated and saved the KPI headers.");
  const snapshot = await inspectDocxStyleSnapshot(state.bytes, runtimeBinding);
  assert.equal(snapshot.tables[0]?.firstRowBoldRunCount, 3);
  assert.equal(snapshot.tables[0]?.shadingColors.find(color => color.value === "D9E2F3")?.count, 3);
  assert.ok(state.persistence.steps.some(step => step.status === "failed"), "historical errors remain in the transcript");
});

test("client-pricing batch failure recovers through individual replacements without hiding a remaining client reference", async () => {
  for (const complete of [true, false]) {
    const operations = [
      { target: { text: "Old Client" }, expectedCurrentText: "Old Client", replacement: "Blue Harbor" },
      ...[["Subtotal 100", "Subtotal 200"], ["Tax 10", "Tax 20"], ["Total 110", "Total 220"]].map(([text, replacement]) => ({ target: { text }, expectedCurrentText: text, replacement })),
    ];
    const { result, state, binding } = await runScriptedDocx({
      bytes: Buffer.from(buildMinimalDocx(["Proposal for Old Client", "Prepared for Old Client", "Subtotal 100", "Tax 10", "Total 110"])),
      instruction: "Update this document: replace all Old Client references with Blue Harbor and update subtotal, tax and total to 200, 20 and 220.",
      turns: [
        { calls: [{ name: "document_batch_replace_text", input: { operations } }] },
        { calls: [{ name: "document_replace_text", input: { ...operations[0], target: { text: "Old Client", occurrence: 0 } } }] },
        ...(complete ? [{ calls: [{ name: "document_replace_text", input: operations[0] }] }] : []),
        { calls: operations.slice(1).map(input => ({ name: "document_replace_text", input })) },
        { text: "Updated all client references and pricing.", calls: [{ name: "finish", input: {} }] },
      ],
    });
    const report = state.reports[0]!;
    console.info(`PHASE2_MEASUREMENT ${JSON.stringify({ scenario: complete ? "client-pricing recovered" : "client-pricing incomplete", outcome: report.outcome, recovered: report.tools.find(tool => tool.outcome === "failure")?.recovered })}`);
    assert.equal(report.outcome, complete ? "success" : "partial");
    assert.equal(result.run.status, complete ? "completed" : "failed");
    assert.equal(report.failures[0]?.code, "TARGET_AMBIGUOUS");
    assert.equal(report.tools.find(tool => tool.outcome === "failure")?.recovered, complete);
    assert.equal(state.appends, 1);
    assert.equal((await binding.findDocxText(state.bytes, { text: "Old Client" })).matchCount, complete ? 0 : 1);
    assert.equal((await binding.findDocxText(state.bytes, { text: "Blue Harbor" })).matchCount, complete ? 2 : 1);
    for (const text of ["Subtotal 200", "Tax 20", "Total 220"]) assert.equal((await binding.findDocxText(state.bytes, { text })).matchCount, 1);
    if (!complete) {
      assert.equal(result.run.errorCode, "AGENT_PARTIAL_COMPLETION");
      assert.match(result.assistantMessage?.content ?? "", /partially[\s\S]*batch_replace_text/);
      assert.notEqual(result.assistantMessage?.content, "Updated all client references and pricing.");
    }
  }
});

test("recovering the first mutation does not hide a skipped sibling", async () => {
  for (const retrySibling of [false, true]) {
    const replace = (text: string) => ({ target: { text }, expectedCurrentText: text, replacement: `${text} updated` });
    const { result, state, binding } = await runScriptedDocx({
      bytes: Buffer.from(buildMinimalDocx(["KPI A", "KPI B"])), instruction: "Update this document: update KPI A and KPI B.",
      turns: [
        { calls: [
          { name: "document_replace_text", input: { ...replace("KPI A"), expectedCurrentText: "Wrong guard" } },
          { name: "document_replace_text", input: replace("KPI B") },
        ] },
        { calls: [{ name: "document_replace_text", input: replace("KPI A") }] },
        ...(retrySibling ? [{ calls: [{ name: "document_replace_text", input: replace("KPI B") }] }] : []),
        { text: "Updated both KPIs.", calls: [{ name: "finish", input: {} }] },
      ],
    });
    const report = state.reports[0]!;
    const skipped = report.tools.find(tool => tool.failureCode === "PRIOR_MUTATION_FAILED");
    assert.ok(skipped);
    assert.equal(skipped.recovered, retrySibling);
    assert.equal(report.outcome, retrySibling ? "success" : "partial");
    assert.equal(result.run.status, retrySibling ? "completed" : "failed");
    assert.equal(state.appends, 1);
    assert.equal((await binding.findDocxText(state.bytes, { text: "KPI B updated" })).matchCount, retrySibling ? 1 : 0);
  }
});


test("Phase 3 scripted Northstar run removes a heading lookup and first-header retry", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Pricing .... 4", "Pricing", "Commercial terms stay unchanged"]) });
  assert.equal((await seed.mutate("set_paragraph_style", { target: { text: "Pricing", occurrence: 1 }, style: "Heading 1" })).ok, true);
  const rows = [["Metric", "Baseline", "Target", "Owner"], ["Detection", "15", "10", "Sam"]];
  assert.equal((await seed.mutate("create_table", { rows, placement: { kind: "end" } })).ok, true);
  const bytes = Buffer.from(seed.currentBytes());
  const inspected = await binding.inspectDocx(bytes, { focus: { kind: "headings" } });
  if (!inspected.headings?.items[0]?.textTarget) return t.skip("Requires the Phase 3 local native engine");
  const previous = process.env.OPENSUITE_ENGINE_PATH;
  delete process.env.OPENSUITE_ENGINE_PATH;
  let baseline;
  try { baseline = await createNapiDocxEngineBinding(); }
  finally { if (previous !== undefined) process.env.OPENSUITE_ENGINE_PATH = previous; }
  const measurements = [];
  for (const [label, engine] of [["before", baseline], ["after", binding]] as const) {
    const table = { headerCells: rows[0] };
    const format = (column: unknown) => ({ name: "document_set_table_cells_formatting", input: { table, updates: [{ target: { row: { kind: "header" }, column }, textFormatting: { bold: true } }] } });
    const replace = (target: unknown) => ({ name: "document_replace_text", input: { target, expectedCurrentText: "Pricing", replacement: "Fees" } });
    const findResult = (prompt: unknown, property: string) => {
      const results = (prompt as { role: string; content: { type: string; output?: { value?: unknown } }[] }[])
        .filter(message => message.role === "tool").flatMap(message => message.content)
        .filter(part => part.type === "tool-result").map(part => part.output?.value)
        .filter((value): value is Record<string, unknown> => !!value && typeof value === "object");
      return results.find(result => property in result)!;
    };
    const { result, state } = await runScriptedDocx({ binding: engine, bytes,
      instruction: "In this document, rename the Pricing body heading to Fees and bold the first KPI header cell.",
      turns: [
        { calls: [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }, { name: "document_inspect", input: { kind: "headings" } }] },
        prompt => {
          const heading = (findResult(prompt, "headings").headings as { items: { textTarget?: unknown }[] }).items[0]!;
          return { calls: heading.textTarget
            ? [format({ kind: "header", text: "Metric" }), replace(heading.textTarget)]
            : [{ name: "document_find", input: { text: "Pricing" } }, format({ kind: "header", text: "Metric" })] };
        },
        prompt => label === "after" ? { calls: [{ name: "finish", input: {} }] }
          : { calls: [format({ kind: "first" }), replace({ text: "Pricing", occurrence: (findResult(prompt, "matches").matches as { occurrence: number }[])[1]!.occurrence })] },
        { calls: [{ name: "finish", input: {} }] },
      ],
    });
    assert.equal(result.run.status, "completed");
    const metrics = state.runtime!.metrics;
    measurements.push({ label, find: metrics.toolCalls.filter(call => call.toolName === "document.find").length,
      inspect: metrics.toolCalls.filter(call => call.toolName === "document.inspect").length,
      errors: metrics.toolCalls.filter(call => call.outcome === "failure").length, turns: metrics.modelTurns.length });
    const paragraphs = await binding.inspectDocx(state.bytes, { focus: { kind: "paragraphs" } });
    assert.deepEqual(paragraphs.paragraphs!.items.map(item => item.text), ["Pricing .... 4", "Fees", "Commercial terms stay unchanged"]);
    assert.deepEqual((await binding.inspectDocx(state.bytes, { focus: { kind: "tables" } })).tables!.items[0]!.rows.map(row => row.cells), rows);
    assert.equal((await inspectDocxStyleSnapshot(state.bytes, binding)).tables[0]!.firstRowBoldRunCount, 1);
  }
  assert.deepEqual(measurements, [
    { label: "before", find: 1, inspect: 1, errors: 1, turns: 4 },
    { label: "after", find: 0, inspect: 1, errors: 0, turns: 3 },
  ]);
  t.diagnostic(`PHASE3_MEASUREMENT ${JSON.stringify(measurements)}`);
});

// Same scripted calls before/after Phase 4: input size is estimated, never provider usage.
test("Phase 4 discovery benchmark saves KPI, header, style, comment and revision edits", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Review this sentence", "Replace this sentence"]) });
  assert.equal((await seed.mutate("create_table", { rows: rosterRows, placement: { kind: "end" } })).ok, true);
  const call = (name: string, input: unknown) => ({ name, input });
  const finish = { calls: [call("finish", {})] };
  const scenarios = [
    { name: "KPI", turns: [{ calls: [call("document_set_table_cells_text", { table: rosterTable, updates: [{ target: { row: { kind: "label", text: "Ada" }, column: { kind: "header", text: "Role" } }, expectedCurrentText: "CEO", replacement: "Founder" }] })] }, finish],
      verify: async (bytes: Buffer) => assert.equal((await binding.inspectDocx(bytes, { focus: { kind: "tables" } })).tables!.items[0]!.rows[1]!.cells[1], "Founder") },
    { name: "header", turns: [
      { calls: [call("capabilities_search", { query: "document.set_table_cells_formatting" })] },
      { calls: [call("capabilities_load", { ids: ["document.set_table_cells_formatting"] })] },
      { calls: [call("document_set_table_cells_formatting", { table: rosterTable, updates: [{ target: headerCell({ kind: "header", text: "Role" }), fill: "D9E2F3", textFormatting: { bold: true } }] })] }, finish],
      verify: async (bytes: Buffer) => { const table = (await inspectDocxStyleSnapshot(bytes, binding)).tables[0]!; assert.equal(table.firstRowBoldRunCount, 1); assert.deepEqual(table.firstRowShadingColors, ["D9E2F3"]); } },
    { name: "global styles", turns: [
      { calls: [call("capabilities_search", { query: "style" }), call("capabilities_list", { parentId: "document" })] },
      // Deliberately repeated discovery verifies its context cost and unchanged surface.
      { calls: [call("capabilities_search", { query: "style" }), call("capabilities_list", { parentId: "document" })] },
      { calls: [call("capabilities_load", { ids: ["document.style_snapshot", "document.update_style"] })] },
      { calls: [call("document_style_snapshot", {})] },
      { calls: [call("document_update_style", { styleId: "Normal", styleType: "paragraph", color: "235744", fontFamily: "Arial" })] }, finish],
      verify: async (bytes: Buffer) => { const style = (await inspectDocxStyleSnapshot(bytes, binding)).styles.find(item => item.styleId === "Normal")!; assert.equal(style.effectiveRunFormatting?.color, "235744"); assert.equal(style.effectiveRunFormatting?.fontFamily, "Arial"); } },
    { name: "comments and revisions", turns: [
      { calls: [call("capabilities_search", { query: "comment" }), call("capabilities_search", { query: "tracked" })] },
      { calls: [call("capabilities_load", { ids: ["document.add_comment", "document.inspect_comments", "document.replace_text_with_tracked_change", "document.inspect_tracked_changes"] })] },
      { calls: [call("document_add_comment", { target: { text: "Review this sentence" }, text: "Check wording", author: "Reviewer", date: "2026-10-12T12:00:00Z" }), call("document_replace_text_with_tracked_change", { target: { text: "Replace this sentence" }, replacement: "Revised sentence", author: "Reviewer", date: "2026-10-12T12:00:00Z" })] },
      { calls: [call("document_inspect_comments", {}), call("document_inspect_tracked_changes", {})] }, finish],
      verify: async (bytes: Buffer) => { assert.match(JSON.stringify(await binding.inspectDocx(bytes, { focus: { kind: "comments" } })), /Check wording/); const changes = JSON.stringify(await binding.inspectDocx(bytes, { focus: { kind: "revisions" } })); assert.match(changes, /Revised sentence/); assert.match(changes, /Replace this sentence/); } },
  ];
  for (const scenario of scenarios) {
    const { result, state } = await runScriptedDocx({ binding, bytes: Buffer.from(seed.currentBytes()), instruction: `Update this document: ${scenario.name}`, turns: scenario.turns });
    assert.equal(result.run.status, "completed", result.run.errorMessage ?? "");
    assert.equal(state.appends, 1);
    assert.equal(state.runtime!.metrics.toolCalls.filter(call => call.outcome === "failure").length, 0);
    await scenario.verify(state.bytes);
    const turns = state.runtime!.metrics.modelTurns;
    const repeated = scenario.turns.flatMap(turn => turn.calls).filter(call => call.name.startsWith("capabilities_")).map(call => JSON.stringify(call));
    t.diagnostic(`PHASE4_MEASUREMENT ${JSON.stringify({ scenario: scenario.name, turns: turns.length,
      discoveryTurns: turns.filter(turn => { const calls = state.runtime!.metrics.toolCalls.filter(call => call.turn === turn.turn); return calls.length && calls.every(call => call.toolName.startsWith("capabilities.")); }).length,
      repeatedDiscovery: repeated.length - new Set(repeated).size,
      initialTools: turns[0]!.exposedToolCount, peakTools: Math.max(...turns.map(turn => turn.exposedToolCount ?? 0)),
      initialSchemaChars: turns[0]!.exposedToolSchemaChars, peakSchemaChars: Math.max(...turns.map(turn => turn.exposedToolSchemaChars ?? 0)),
      estimatedInputTokens: state.estimatedModelInputTokens })}`);
  }
});

// The same script uses the current tool list after Continue, loading only if absent.
test("Phase 4 Continue benchmark reuses loaded tools after the 20-turn bound", async (t) => {
  const resume = (prompt: unknown): ScriptedTurn => {
    const hasTool = JSON.stringify(prompt).includes("- document_set_text_formatting");
    return hasTool ? { calls: [
      { name: "document_set_text_formatting", input: { target: { text: "Continue paragraph" }, bold: true } },
      { name: "finish", input: {} },
    ] } : { calls: [
      { name: "capabilities_search", input: { query: "document.set_text_formatting" } },
      { name: "capabilities_load", input: { ids: ["document.set_text_formatting"] } },
    ] };
  };
  const { result, state, execution, binding } = await runScriptedDocx({
    bytes: Buffer.from(buildMinimalDocx(["Continue paragraph"])), instruction: "Update this document: bold the existing paragraph.",
    turns: [
      { calls: [{ name: "capabilities_load", input: { ids: ["document.set_text_formatting"] } }] },
      ...Array.from({ length: 19 }, () => ({ calls: [{ name: "document_inspect", input: { kind: "overview" } }] })),
      resume,
      // A successful load is authoritative in the same script's next model turn.
      { calls: [{ name: "document_set_text_formatting", input: { target: { text: "Continue paragraph" }, bold: true } }, { name: "finish", input: {} }] },
    ],
  });
  assert.equal(result.run.errorCode, "AGENT_MAX_TURNS");
  assert.equal(state.runtime!.metrics.modelTurns.length, 20);
  const priorInputTokens = state.estimatedModelInputTokens;
  const continued = await (await execution.start({ userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: "Continue", continueFromRunId: result.run.id })).result;
  assert.equal(continued.run.status, "completed", continued.run.errorMessage ?? "");
  assert.equal(state.appends, 1);
  const snapshot = await inspectDocxStyleSnapshot(state.bytes, binding);
  assert.match(JSON.stringify(snapshot), /"bold":true/);
  const discovery = state.runtime!.metrics.toolCalls.filter(call => call.toolName.startsWith("capabilities."));
  t.diagnostic(`PHASE4_CONTINUE ${JSON.stringify({ turns: state.runtime!.metrics.modelTurns.length, discoveryCalls: discovery.length,
    estimatedInputTokens: state.estimatedModelInputTokens - priorInputTokens })}`);
  assert.equal(state.runtime!.metrics.modelTurns.length, 1);
  assert.equal(discovery.length, 0);
});

// Real execution, registry, native reads/mutations, and saved bytes; only the model is scripted.
test("Phase 5 benchmark preserves active evidence across reads, edits, and recovery", async (t) => {
  const native = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding: native, bytes: buildMinimalDocx(["Pricing .... 4", "Pricing", "Details"]) });
  assert.equal((await seed.mutate("set_paragraph_style", { target: { text: "Pricing", occurrence: 1 }, style: "Heading 1" })).ok, true);
  const rows = [rosterRows[0]!, ...Array.from({ length: 30 }, (_, i) => [i ? `Person ${i}` : "Ada", i ? "Unchanged role ".repeat(30) : "CEO"])];
  assert.equal((await seed.mutate("create_table", { rows, placement: { kind: "end" } })).ok, true);
  const call = (name: string, input: unknown) => ({ name, input });
  const inspect = { calls: [call("document_inspect", { kind: "tables" })] };
  const edit = (row = "Ada") => ({ calls: [call("document_set_table_cells_text", { table: rosterTable, updates: [{
    target: { row: { kind: "label", text: row }, column: { kind: "header", text: "Role" } }, expectedCurrentText: "CEO", replacement: "Founder",
  }] })] });
  const finish = { text: "Updated the requested content.", calls: [call("finish", {})] };
  const snapshot = { calls: [call("document_style_snapshot", {})] };
  const scenarios = [
    { name: "A KPI", turns: [inspect, edit(), finish] },
    { name: "B unchanged inspect", turns: [inspect, inspect, edit(), finish] },
    { name: "C read after edit", turns: [inspect, edit(), inspect, finish] },
    { name: "D ambiguous heading", turns: [
      { calls: [call("document_find", { text: "Pricing" })] }, { calls: [call("document_find", { text: "Pricing" })] },
      { calls: [call("document_replace_text", { target: { text: "Pricing", occurrence: 1 }, expectedCurrentText: "Pricing", replacement: "Fees" })] }, finish,
    ] },
    { name: "E global styling", turns: [
      { calls: [call("capabilities_load", { ids: ["document.style_snapshot", "document.update_style", "document.set_paragraph_formatting", "document.set_text_formatting"] })] },
      snapshot, snapshot, inspect, inspect,
      { calls: [call("document_update_style", { styleId: "Normal", styleType: "paragraph", color: "235744" })] }, snapshot,
      { calls: [call("document_set_paragraph_formatting", { target: { text: "Details" }, alignment: "center" })] },
      { calls: [call("document_set_text_formatting", { target: { text: "Pricing", occurrence: 1 }, italic: true })] }, inspect, inspect, finish,
    ] },
    { name: "F failed edit and recovery", turns: [inspect, edit(), edit(), finish] },
  ];
  for (const scenario of scenarios) {
    let nativeReads = 0;
    let nativeMutations = 0;
    let failedOnce = false;
    const binding = { ...native,
      inspectDocx: async (...args: Parameters<typeof native.inspectDocx>) => { nativeReads++; return native.inspectDocx(...args); },
      findDocxText: async (...args: Parameters<typeof native.findDocxText>) => { nativeReads++; return native.findDocxText(...args); },
      readDocxOperation: async (...args: Parameters<NonNullable<typeof native.readDocxOperation>>) => { nativeReads++; return native.readDocxOperation!(...args); },
      executeDocxOperation: async (...args: Parameters<NonNullable<typeof native.executeDocxOperation>>) => {
        if (scenario.name.startsWith("F") && !failedOnce) { failedOnce = true; return { result: { ok: false as const, reasonCode: "TABLE_ROW_NOT_FOUND", status: "error" as const, capability: "set_table_cells_text", changes: [], diagnostics: [] } }; }
        nativeMutations++; return native.executeDocxOperation!(...args);
      },
    };
    const { result, state } = await runScriptedDocx({ binding, bytes: Buffer.from(seed.currentBytes()), instruction: `Update this document: ${scenario.name}`, turns: scenario.turns });
    assert.equal(result.run.status, "completed", result.run.errorMessage ?? "");
    assert.equal(state.appends, 1);
    const inputs = state.modelInputs;
    for (const input of inputs) assert.ok(input.includes(`Update this document: ${scenario.name}`));
    const parts = JSON.parse(inputs.at(-1)!).flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : []);
    const callIds = parts.filter((part: { type: string }) => part.type === "tool-call").map((part: { toolCallId: string }) => part.toolCallId);
    assert.deepEqual(parts.filter((part: { type: string }) => part.type === "tool-result").map((part: { toolCallId: string }) => part.toolCallId), callIds);
    const duplicateIds = scenario.name.startsWith("B") || scenario.name.startsWith("D") ? ["2-0"]
      : scenario.name.startsWith("E") ? ["3-0", "5-0", "11-0"] : [];
    const duplicateBytes = parts.filter((part: { type: string; toolCallId: string }) => part.type === "tool-result" && duplicateIds.includes(part.toolCallId))
      .reduce((sum: number, part: { output: { value: unknown } }) => sum + Buffer.byteLength(JSON.stringify(part.output.value)), 0);
    if (scenario.name === "C read after edit") assert.match(inputs.at(-1)!, /Founder/);
    if (scenario.name.startsWith("F")) {
      assert.match(inputs.at(-1)!, /Ada/);
      assert.match(inputs.at(-1)!, /TABLE_ROW_NOT_FOUND/);
      assert.match(inputs.at(-1)!, /Founder/);
      assert.equal(state.reports[0]!.outcome, "success");
      assert.equal(state.reports[0]!.tools.find(tool => tool.outcome === "failure")?.recovered, true);

    }
    const calls = state.runtime!.metrics.toolCalls;
    // Include validation reads in the native count; both versions use the same verification.
    t.diagnostic(`PHASE5_MEASUREMENT ${JSON.stringify({ scenario: scenario.name, modelTurns: state.runtime!.turns,
      readCalls: calls.filter(call => call.kind === "read" && call.toolName.startsWith("document.")).length,
      nativeReads, nativeMutations, duplicateBytes, errors: calls.filter(call => call.outcome === "failure").length,
      estimatedInputTokens: state.estimatedModelInputTokens, peakInputTokens: state.peakModelInputTokens, savedVersions: state.appends })}`);
    const saved = await native.inspectDocx(state.bytes, { focus: { kind: "paragraphs" } });
    const paragraphs = saved.paragraphs!.items.map(item => item.text);
    assert.deepEqual(paragraphs, scenario.name.startsWith("D") ? ["Pricing .... 4", "Fees", "Details"] : ["Pricing .... 4", "Pricing", "Details"]);
    const table = (await native.inspectDocx(state.bytes, { focus: { kind: "tables" } })).tables!.items[0]!;
    assert.deepEqual(table.rows.map(row => row.cells), scenario.name.startsWith("D") || scenario.name.startsWith("E") ? rows : rows.map((row, index) => index === 1 ? ["Ada", "Founder"] : row));
    if (scenario.name.startsWith("E")) {
      const styles = await inspectDocxStyleSnapshot(state.bytes, native);
      assert.equal(styles.styles.find(style => style.styleId === "Normal")?.effectiveRunFormatting?.color, "235744");
      assert.match(JSON.stringify(styles), /"alignment":"center"/);
      assert.match(JSON.stringify(styles), /"italic":true/);
    }
  }
});

test("Phase 5 bounded task and later independent request retain the right history", async (t) => {
  const native = await createNapiDocxEngineBinding();
  let nativeReads = 0;
  let nativeMutations = 0;
  const binding = { ...native,
    readDocxOperation: async (...args: Parameters<NonNullable<typeof native.readDocxOperation>>) => { nativeReads++; return native.readDocxOperation!(...args); },
    executeDocxOperation: async (...args: Parameters<NonNullable<typeof native.executeDocxOperation>>) => { nativeMutations++; return native.executeDocxOperation!(...args); },
  };
  const snapshot = { calls: [{ name: "document_style_snapshot", input: {} }] };
  const instruction = "Update this document: color Normal green and bold Details. Preserve all wording.";
  const { result, state, execution } = await runScriptedDocx({ binding, bytes: Buffer.from(buildMinimalDocx(["Details"])), instruction,
    turns: [
      { reasoning: "Preserve wording and finish both formatting changes.", calls: [{ name: "capabilities_load", input: { ids: ["document.style_snapshot", "document.update_style", "document.set_text_formatting"] } }] },
      snapshot,
      { calls: [{ name: "document_update_style", input: { styleId: "Normal", styleType: "paragraph", color: "235744" } }] },
      ...Array.from({ length: 17 }, () => snapshot),
      { text: "Changed Normal color and made Details bold.", calls: [{ name: "document_set_text_formatting", input: { target: { text: "Details" }, bold: true } }, { name: "finish", input: {} }] },
      { text: "Earlier I changed Normal color and made Details bold.", calls: [{ name: "finish", input: {} }] },
    ],
  });
  assert.equal(result.run.errorCode, "AGENT_MAX_TURNS");
  assert.equal(state.appends, 1);
  assert.equal(state.versionId, "v2");
  for (const prompt of state.modelInputs.slice(1, 20)) {
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /Preserve wording and finish both formatting changes/);
  }
  const last = state.modelInputs[19]!;
  assert.match(last, /"styleId":"Normal"/);
  assert.match(last, /"color":"235744"/);
  assert.match(last, /"schemaVersion":1/);
  const continued = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Continue", continueFromRunId: result.run.id })).result;
  assert.equal(continued.run.status, "completed");
  assert.equal(continued.run.baseDocumentVersionId, "v2");
  assert.equal(state.appends, 2);
  const resumed = state.modelInputs[20]!;
  assert.ok(resumed.includes(instruction));
  assert.match(resumed, /document.update_style ×1/);
  assert.match(resumed, /current version: v2/);
  assert.match(resumed, /document_set_text_formatting/);
  const styles = await inspectDocxStyleSnapshot(state.bytes, binding);
  assert.equal(styles.styles.find(style => style.styleId === "Normal")?.effectiveRunFormatting?.color, "235744");
  assert.match(JSON.stringify(styles), /"bold":true/);
  t.diagnostic(`PHASE5_CONTINUE ${JSON.stringify({ turns: state.modelInputs.length, estimatedInputTokens: state.estimatedModelInputTokens,
    peakInputTokens: state.peakModelInputTokens, nativeStyleReads: nativeReads, nativeMutations, savedVersions: state.appends })}`);
  const oldInputTokens = state.estimatedModelInputTokens;
  const independent = await (await execution.start({ userId: "user-1", threadId: "thread-1", instruction: "What did you change earlier?" })).result;
  assert.equal(independent.run.status, "completed");
  const next = state.modelInputs[21]!;
  assert.match(next, /Changed Normal color and made Details bold/);
  assert.doesNotMatch(next, /"type":"tool-call"|"type":"tool-result"|"paragraphPatterns"|Preserve wording and finish both formatting changes/);
  assert.equal(state.appends, 2);
  assert.ok(state.persistence.steps.some(step => step.name === "document.update_style"));
  t.diagnostic(`PHASE5_INDEPENDENT ${JSON.stringify({ turns: 1, estimatedInputTokens: state.estimatedModelInputTokens - oldInputTokens, savedVersions: 0 })}`);
});
