import { buildTestPdf } from "../chat-attachments/pdf-test-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createAttachmentExtractionService, type AttachmentSource, type AttachmentScope } from "../chat-attachments/extraction.js";
import { ChatAttachmentError, type ChatAttachmentDto } from "../chat-attachments/service.js";
import { createAttachmentEvidence, createAttachmentTools } from "./attachment-evidence.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent, type RunAgentResult, type RunModelResult, type AgentModel } from "@opensuite/agent-core";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import sharp from "sharp";
import { bindDocxDocument, buildDocxBody, buildMinimalDocx, createNapiDocxEngineBinding, inspectDocxStyleSnapshot } from "@opensuite/engine-client";
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
      attachmentIds?: readonly string[];
    }) {
      const message: AgentMessage = {
        id: `msg-${++messageSeq}`,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        ...(input.documentIds?.length ? { documentIds: input.documentIds } : {}),
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
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
    runAgent: async (input) => {
      const result = await runAgentImpl(input);
      return !result.continuation && ['max_turns', 'deadline'].includes(result.stopReason)
        ? { ...result, continuation: { messages: input.messages, turns: result.turns, failures: [] } } : result;
    },
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

test('brand tools and skills apply a small logo once and respect opt-out', async t => {
  for (const mode of ['skill', 'logo-only', 'omit-logo'] as const) await t.test(mode, async () => {
    const persistence = memoryPersistence('user-1');
    const binding = await createNapiDocxEngineBinding();
    const versions = new Map<string, Buffer>();
    let document = { id: 'report-1', name: 'Q3 report.docx', workspaceId: 'ws-1', format: 'docx', latestVersion: { id: 'v1' } };
    let brandReads = 0;
    let logoReads = 0;
    const logoPng = await sharp({ create: { width: mode === 'skill' ? 1600 : 800, height: 800, channels: 4, background: '#124733' } }).png().toBuffer();
    const execution = createAgentExecutionService({
      ...baseDeps(persistence, async (input) => {
        const firstTurn = await input.projectTools!({ turn: 1 } as never);
        await firstTurn['capabilities.load']!.execute!({ ids: ['workspace.get_brand', ...(mode !== 'logo-only' ? ['skills.reporting.analytical-report'] : []), ...(mode !== 'skill' ? ['document.apply_workspace_brand'] : [])] }, {} as never);
        const tools = await input.projectTools!({ turn: 2 } as never);
        const savedBrand = await tools['workspace.get_brand']!.execute!({}, {} as never);
        assert.match(JSON.stringify(savedBrand), /Cincinnati Sports Club/);
        assert.match(input.system ?? '', /empty style.list_profiles never proves the workspace brand is missing/);
        await tools['workspace.create_blank_document']!.execute!({ title: document.name }, {} as never);
        await tools['document.insert_paragraphs']!.execute!({ texts: ['Q3 operating report', 'Executive Summary', 'Revenue: $3.8M'], placement: { kind: 'end' } }, {} as never);
        await tools['document.set_paragraph_style']!.execute!({ target: { text: 'Q3 operating report' }, style: 'Title' }, {} as never);
        await tools['document.set_paragraph_style']!.execute!({ target: { text: 'Executive Summary' }, style: 'Heading 1' }, {} as never);
        await tools['document.create_table']!.execute!({ placement: { kind: 'end' }, rows: [['Metric', 'Value'], ['Revenue', '$3.8M']] }, {} as never);
        if (mode !== 'skill') {
          await tools['document.apply_workspace_brand']!.execute!({ includeLogo: mode !== 'omit-logo' }, {} as never);
          await tools['document.apply_workspace_brand']!.execute!({ includeLogo: mode !== 'omit-logo' }, {} as never);
        }
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
      workspaceBrand: { get: async (workspaceId, userId) => {
        assert.equal(workspaceId, 'ws-1');
        assert.equal(userId, 'user-1');
        brandReads++;
        return { schemaVersion: 1, workspaceId: 'ws-1', createdAt: '', updatedAt: '', logoAssetId: 'logo-1',
          organization: { name: 'Cincinnati Sports Club', website: '', email: '', phone: '', address: '' },
          colors: mode === 'skill' ? { primary: '#124733', secondary: '#124733', accent: '#124733' } : { primary: null, secondary: null, accent: null }, typography: mode === 'skill' ? { headingFont: 'Arial', bodyFont: 'Arial' } : { headingFont: '', bodyFont: '' } };
      } },
      workspaceAssets: {
        listImages: async () => ({ items: [], offset: 0, limit: 20 }),
        readBytes: async () => {
          logoReads++;
          return { bytes: logoPng, contentType: 'image/png' };
        },
      },
    });
    const result = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Create a professional quarterly operating report with metrics using our saved brand.' })).result;
    assert.equal(result.run.status, 'completed');
    assert.equal(brandReads, 1);
    assert.equal(logoReads, mode === 'skill' ? 1 : mode === 'logo-only' ? 2 : 0);
    const snapshot = await inspectDocxStyleSnapshot(new Uint8Array(versions.get('v2')!), binding);
    if (mode === 'skill') {
      assert.equal(snapshot.tables[0]?.firstRowShadingColors[0], '124733');
      assert.ok(snapshot.typography.textColors.some((color) => color.value === 'FFFFFF'));
      for (const styleId of ['Title', 'Heading1']) {
        assert.ok(snapshot.typography.runPatterns.some((pattern) => pattern.paragraphStyleId === styleId && (pattern.effectiveFormatting ?? pattern.directFormatting).color === '124733'), styleId);
      }
      assert.ok(snapshot.typography.runPatterns.some((pattern) => (pattern.effectiveFormatting ?? pattern.directFormatting).fontFamily === 'Arial'));
    }
    const blocks = await binding.inspectDocx(new Uint8Array(versions.get('v2')!), { focus: { kind: 'body_blocks', offset: 0, limit: 100 } });
    if (mode === 'omit-logo') {
      assert.equal(blocks.bodyBlocks?.items.some(block => block.kind === 'picture'), false);
    } else {
      assert.equal(blocks.bodyBlocks?.items[0]?.kind, 'picture');
      assert.equal(blocks.bodyBlocks?.items.filter(block => block.kind === 'picture').length, 1, 'reapplying the brand must not duplicate the logo');
      assert.ok((blocks.bodyBlocks?.items[0]?.picture?.widthEmu ?? Infinity) <= 1_371_600);
      assert.ok((blocks.bodyBlocks?.items[0]?.picture?.heightEmu ?? Infinity) <= 457_200);
      const picture = blocks.bodyBlocks!.items[0]!.picture!;
      assert.equal(picture.widthEmu / picture.heightEmu, mode === 'skill' ? 2 : 1);
    }
  });
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

test("legacy continuation without a full transcript fails before a new run", async () => {
  const persistence = memoryPersistence("user-1");
  const original = await persistence.appendMessage({ threadId: "thread-1", ownerUserId: "user-1", role: "user", content: "Rewrite the Risks section." });
  const partial = await persistence.createRun({ threadId: "thread-1", ownerUserId: "user-1", createdByUserId: "user-1", triggeringMessageId: original.id, status: "queued" });
  await persistence.updateRunStatus({ runId: partial.id, ownerUserId: "user-1", status: "failed", errorCode: "AGENT_MAX_TURNS" });
  const execution = createAgentExecutionService(baseDeps(persistence, async () => { throw new Error("Must not call model"); }));
  await assert.rejects(execution.start({ userId: "user-1", threadId: "thread-1", instruction: "Continue", continueFromRunId: partial.id }), /no saved execution context/);
  assert.equal(persistence.runs.size, 1);
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

test('workspace brand formatting cannot substitute for a requested saved document style', async () => {
  const persistence = memoryPersistence('user-1');
  const binding = await createNapiDocxEngineBinding();
  const original = buildMinimalDocx(['Existing club content']);
  const document = { id: 'doc-1', workspaceId: 'ws-1', name: 'Club.docx', format: 'docx', latestVersion: { id: 'v1' } };
  const execution = createAgentExecutionService({
    ...baseDeps(persistence, async input => {
      const initial = await input.projectTools!({ turn: 1 } as never);
      await initial['capabilities.load']!.execute!({ ids: ['document.apply_workspace_brand'] }, {} as never);
      const tools = await input.projectTools!({ turn: 2 } as never);
      await tools['document.apply_workspace_brand']!.execute!({}, {} as never);
      await assert.rejects(async () => tools.finish!.execute!({}, {} as never), /style.apply_profile/);
      return softResult('completed', 'Applied your saved Resume Style.');
    }),
    docxBinding: binding,
    documents: {
      listInWorkspace: async () => [document] as never,
      getOwnedDocument: async () => document as never,
      readExactVersionBytes: async () => original,
      appendDocumentVersion: async () => ({ version: { id: 'v2', versionNumber: 2 } }) as never,
      createBlankDocxDocument: async () => { throw new Error('unused'); },
      createOfficeDocumentFromBytes: async () => { throw new Error('unused'); },
    },
    workspaceBrand: { get: async () => ({ schemaVersion: 1, workspaceId: 'ws-1', createdAt: '', updatedAt: '', logoAssetId: null,
      organization: { name: 'Club', website: '', email: '', phone: '', address: '' },
      colors: { primary: '#123456', secondary: null, accent: null }, typography: { headingFont: 'Georgia', bodyFont: 'Georgia' } }) },
  });
  const result = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', activeDocumentId: 'doc-1', instruction: 'Apply my Resume Style to this document.' })).result;
  assert.equal(result.run.status, 'failed');
  assert.match(result.run.errorMessage ?? '', /saved style was not applied and verified/);
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
  readonly maxTurns?: number;
  readonly documentIds?: readonly string[];
  readonly references?: readonly { id: string; name: string; bytes: Buffer }[];
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
    modelRequests: [] as string[],
    estimatedModelInputTokens: 0,
    modelInputs: [] as string[],
    peakModelInputTokens: 0,
    peakModelRequestBytes: 0,
    generatedArgumentBytes: 0,
    runtime: undefined as RunAgentResult | undefined,
    reports: [] as AgentRunReport[],
    usage: [] as { agentRunId?: string | null; inputTokens?: number }[],
    debits: [] as string[],
    events: [] as AgentEvent[],
    persistence,
  };
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    state.modelRequests.push(JSON.stringify({ prompt: options.prompt, tools: options.tools }));
    state.peakModelRequestBytes = Math.max(state.peakModelRequestBytes, Buffer.byteLength(state.modelRequests.at(-1)!));
    state.exposedTools.push(options.tools?.map((tool) => tool.name) ?? []);
    const inputTokens = estimateTokens(JSON.stringify({ prompt: options.prompt, tools: options.tools }));
    state.estimatedModelInputTokens += inputTokens;
    state.peakModelInputTokens = Math.max(state.peakModelInputTokens, inputTokens);
    state.modelInputs.push(JSON.stringify(options.prompt));
    const scripted = input.turns[turn++] ?? { calls: [] };
    const current = typeof scripted === "function" ? scripted(options.prompt) : scripted;
    state.generatedArgumentBytes += current.calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.input)), 0);
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
    state.runtime = await runAgent({ ...agentInput, model, ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}) });
    return state.runtime;
  });
  const executionDeps: AgentExecutionServiceDeps = {
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
      ...(input.references ? { listInWorkspace: async () => [
        { id: 'doc-1', name: 'Roster.docx', workspaceId: 'ws-1', format: 'docx', latestVersion: { id: state.versionId } },
        ...input.references!.map(reference => ({ id: reference.id, name: reference.name, workspaceId: 'ws-1', format: 'docx', latestVersion: { id: `${reference.id}-v1` } })),
      ] as never } : {}),
      getOwnedDocument: async ({ documentId }) => {
        const reference = input.references?.find(reference => reference.id === documentId);
        return { id: documentId, name: reference?.name ?? 'Roster.docx', workspaceId: 'ws-1', format: 'docx', latestVersion: { id: reference ? `${reference.id}-v1` : state.versionId } } as never;
      },
      readExactVersionBytes: async ({ documentId, versionId }) => {
        const reference = input.references?.find(reference => reference.id === documentId);
        if (reference) return reference.bytes;
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
  };
  const execution = createAgentExecutionService(executionDeps);
  const result = await (await execution.start({
    userId: "user-1", threadId: "thread-1", activeDocumentId: "doc-1", instruction: input.instruction,
    documentIds: input.documentIds,
    signal: controller.signal, liveEvents: { emit: (event) => { state.events.push(event); } },
  })).result;
  return { binding, result, state, execution, restart: (overrides: Partial<AgentExecutionServiceDeps> = {}) => createAgentExecutionService({ ...executionDeps, ...overrides }) };
}

async function rosterTableDocx(): Promise<Buffer> {
  const seed = bindDocxDocument({ binding: await createNapiDocxEngineBinding(), bytes: buildMinimalDocx(["Team roster"]) });
  assert.equal((await seed.mutate("create_table", { rows: rosterRows, placement: { kind: "end" } })).ok, true);
  return Buffer.from(seed.currentBytes());
}

test('Phase 8: proposal pricing, KPI, milestones and narrative save exact values once', async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const narrative = 'Commercial forecast: $278,500. Downtime target: 24%. Start November 16, 2026; finish March 8, 2027.';
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(['Northstar proposal', narrative]) });
  const rows = [
    [['Item', 'Price'], ['Discovery', '$90,000'], ['Equipment', '$75,000'], ['Training', '$50,000'], ['Support', '$38,500'], ['Travel', '$25,000'], ['Total', '$278,500']],
    [['KPI', 'Baseline', 'Target'], ['Downtime', '100 hours', '76 hours'], ['Maintenance Cost', '$185,000/quarter', '$155,000/quarter']],
    [['Milestone', 'Date'], ['Start', 'November 16, 2026'], ['Finish', 'March 8, 2027']],
  ];
  for (const table of rows) assert.equal((await seed.mutate('create_table', { rows: table, placement: { kind: 'end' } })).ok, true);
  const cell = (row: string, column: string, before: string, after: string) => ({ target: { row: { kind: 'label', text: row }, column: { kind: 'header', text: column } }, expectedCurrentText: before, replacement: after });
  let nativeMutations = 0;
  const counted = { ...binding, executeDocxOperation: async (...args: Parameters<NonNullable<typeof binding.executeDocxOperation>>) => {
    nativeMutations++; return binding.executeDocxOperation!(...args);
  } };
  const reference = Buffer.from(buildMinimalDocx(['Read-only reference: approved scope is 12 lines and 48 machines.']));
  const originalReference = Buffer.from(reference);
  const started = performance.now();
  const run = await runScriptedDocx({ binding: counted, bytes: Buffer.from(seed.currentBytes()),
    instruction: 'In the currently open Roster.docx, update Discovery to $100,000, total to $288,500; downtime target to 70 hours (30% reduction), start to November 23, 2026 and finish to March 15, 2027. Update the narrative too. Keep KPI baselines, other prices and the attached reference unchanged.',
    documentIds: ['doc-1', 'source'], references: [{ id: 'source', name: 'Approved scope.docx', bytes: reference }],
    turns: [
      { calls: [{ name: 'document_set_table_cells_text', input: { table: { headerCells: rows[0]![0] }, updates: [cell('Discovery', 'Price', '$90,000', '$100,000'), cell('Total', 'Price', '$278,500', '$288,500')] } }] },
      { calls: [{ name: 'document_set_table_cells_text', input: { table: { headerCells: rows[1]![0] }, updates: [cell('Downtime', 'Target', '76 hours', '70 hours')] } }] },
      { calls: [{ name: 'document_set_table_cells_text', input: { table: { headerCells: rows[2]![0] }, updates: [cell('Start', 'Date', 'November 16, 2026', 'November 23, 2026'), cell('Finish', 'Date', 'March 8, 2027', 'March 15, 2027')] } }] },
      { calls: [{ name: 'document_replace_text', input: { target: { text: narrative }, expectedCurrentText: narrative, replacement: 'Commercial forecast: $288,500. Downtime target: 30%. Start November 23, 2026; finish March 15, 2027.' } }] },
      { text: 'Updated the requested prices, target, dates and narrative.', calls: [{ name: 'finish', input: {} }] },
    ],
  });
  assert.equal(run.result.run.status, 'completed', run.result.run.errorMessage ?? '');
  assert.equal(run.state.appends, 1);
  assert.equal(run.state.reports[0]?.document?.finalDocumentId, 'doc-1');
  assert.deepEqual(reference, originalReference);
  const expected = structuredClone(rows);
  expected[0]![1]![1] = '$100,000'; expected[0]![6]![1] = '$288,500';
  expected[1]![1]![2] = '70 hours';
  expected[2]![1]![1] = 'November 23, 2026'; expected[2]![2]![1] = 'March 15, 2027';
  const tables = await binding.inspectDocx(run.state.bytes, { focus: { kind: 'tables' } });
  assert.deepEqual(tables.tables!.items.map(table => table.rows.map(row => row.cells)), expected);
  assert.equal(expected[0]!.slice(1, -1).reduce((sum, row) => sum + Number(row[1]!.replace(/[$,]/g, '')), 0), 288500);
  const paragraphs = await binding.inspectDocx(run.state.bytes, { focus: { kind: 'paragraphs' } });
  assert.ok(paragraphs.paragraphs!.items.some(p => p.text === 'Commercial forecast: $288,500. Downtime target: 30%. Start November 23, 2026; finish March 15, 2027.'));
  assert.equal(nativeMutations, 4);
  t.diagnostic(`PHASE8_PROPOSAL ${JSON.stringify({ scripted: true, modelTurns: run.state.runtime!.metrics.modelTurns.length,
    toolCalls: run.state.runtime!.metrics.toolCalls.length, nativeMutations, savedVersions: run.state.appends,
    wallClockMs: Math.round(performance.now() - started), providerCalls: 0, correct: true })}`);
});

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
    assert.match(JSON.stringify(await input.projectMessages!(input.messages)), /Current document ID: second/);
    const tools = input.projectTools!({ tools: input.tools!, turn: 1, messages: input.messages });
    assert.ok(tools["document.set_text_formatting"]);
    assert.equal(tools["document.batch_text_formatting"], undefined);
    assert.match(JSON.stringify(await input.projectMessages!(input.messages)), /Loaded IDs: document.set_text_formatting/);
    assert.match(JSON.stringify(await input.projectMessages!(input.messages)), /Current document ID: second; current version: second-v1/);
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
  await assert.rejects(resume(), (error: unknown) => (error as { code: string }).code === "INVALID_CONTINUATION");
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


test("Phase 3 scripted Northstar run removes a heading lookup and first-header retry", async () => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Pricing .... 4", "Pricing", "Commercial terms stay unchanged"]) });
  assert.equal((await seed.mutate("set_paragraph_style", { target: { text: "Pricing", occurrence: 1 }, style: "Heading 1" })).ok, true);
  const rows = [["Metric", "Baseline", "Target", "Owner"], ["Detection", "15", "10", "Sam"]];
  assert.equal((await seed.mutate("create_table", { rows, placement: { kind: "end" } })).ok, true);
  const bytes = Buffer.from(seed.currentBytes());
  const inspected = await binding.inspectDocx(bytes, { focus: { kind: "headings" } });
  assert.ok(inspected.headings?.items[0]?.textTarget, "published engine must expose heading textTarget");
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
  const { result, state } = await runScriptedDocx({ binding, bytes,
    instruction: "In this document, rename the Pricing body heading to Fees and bold the first KPI header cell.",
    turns: [
      { calls: [{ name: "capabilities_load", input: { ids: ["document.tables.styling"] } }, { name: "document_inspect", input: { kind: "headings" } }] },
      prompt => {
        const heading = (findResult(prompt, "headings").headings as { items: { textTarget?: unknown }[] }).items[0]!;
        return { calls: [format({ kind: "header", text: "Metric" }), replace(heading.textTarget)] };
      },
      { calls: [{ name: "finish", input: {} }] },
    ],
  });
  assert.equal(result.run.status, "completed");
  const metrics = state.runtime!.metrics;
  assert.deepEqual({
    find: metrics.toolCalls.filter(call => call.toolName === "document.find").length,
    inspect: metrics.toolCalls.filter(call => call.toolName === "document.inspect").length,
    errors: metrics.toolCalls.filter(call => call.outcome === "failure").length,
    turns: metrics.modelTurns.length,
  }, { find: 0, inspect: 1, errors: 0, turns: 3 });
  const paragraphs = await binding.inspectDocx(state.bytes, { focus: { kind: "paragraphs" } });
  assert.deepEqual(paragraphs.paragraphs!.items.map(item => item.text), ["Pricing .... 4", "Fees", "Commercial terms stay unchanged"]);
  assert.deepEqual((await binding.inspectDocx(state.bytes, { focus: { kind: "tables" } })).tables!.items[0]!.rows.map(row => row.cells), rows);
  assert.equal((await inspectDocxStyleSnapshot(state.bytes, binding)).tables[0]!.firstRowBoldRunCount, 1);
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
    const hasTool = JSON.stringify(prompt).includes("Loaded IDs: document.set_text_formatting");
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
  assert.match(resumed, /"toolName":"document_update_style"/);
  assert.match(resumed, /Preserve wording and finish both formatting changes/);
  assert.match(resumed, /current version: v2/);
  assert.match(resumed, /document.set_text_formatting/);
  assert.ok(state.exposedTools[20]!.includes('document_set_text_formatting'));
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

test('Phase 6: native DOCX Turn 21 matches uninterrupted serialization after persisted Continue', async (t) => {
  const native = await createNapiDocxEngineBinding();
  const bytes = await rosterTableDocx();
  const edit = { name: 'document_set_table_cells_text', input: { table: rosterTable, updates: [{
    target: { row: { kind: 'label', text: 'Ada' }, column: { kind: 'header', text: 'Role' } },
    expectedCurrentText: 'CEO', replacement: 'Founder',
  }] } };
  const turns: ScriptedTurn[] = [
    { reasoning: 'Keep the original facts. Update Ada, Normal color, then bold the heading.', calls: [{ name: 'capabilities_load', input: { ids: ['document.style_snapshot', 'document.update_style', 'document.set_text_formatting'] } }] },
    { calls: [{ name: 'document_inspect', input: { kind: 'tables' } }] },
    { calls: [edit] }, { calls: [edit] },
    { calls: [{ name: 'document_update_style', input: { styleId: 'Normal', styleType: 'paragraph', color: '235744' } }] },
    ...Array.from({ length: 15 }, () => ({ calls: [{ name: 'document_style_snapshot', input: {} }] })),
    { calls: [{ name: 'document_set_text_formatting', input: { target: { text: 'Team roster' }, bold: true } }] },
    { text: 'Updated Ada, Normal color, and the heading.', calls: [{ name: 'finish', input: {} }] },
  ];
  async function scenario(bounded: boolean) {
    let failed = false;
    let mutations = 0;
    const binding = { ...native, executeDocxOperation: async (...args: Parameters<NonNullable<typeof native.executeDocxOperation>>) => {
      if (args[1] === 'set_table_cells_text' && !failed) {
        failed = true;
        return { result: { ok: false as const, status: 'error' as const, capability: args[1], reasonCode: 'TABLE_ROW_NOT_FOUND', changes: [], diagnostics: [] } };
      }
      mutations++;
      return native.executeDocxOperation!(...args);
    } };
    const run = await runScriptedDocx({ binding, bytes, instruction: 'Update this document: change Ada to Founder, color Normal green, and bold Team roster. Preserve all other wording.', turns,
      ...(!bounded ? { maxTurns: 22 } : {}) });
    if (bounded) {
      assert.equal(run.result.run.errorCode, 'AGENT_MAX_TURNS');
      assert.equal(run.state.appends, 1);
      assert.ok(run.state.persistence.steps.at(-1)?.output?.continuation);
      const saved = JSON.parse(JSON.stringify(run.state.persistence.steps));
      run.state.persistence.steps.splice(0, run.state.persistence.steps.length, ...saved);
      const continued = await (await run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id })).result;
      assert.equal(continued.run.status, 'completed', continued.run.errorMessage ?? '');
      assert.equal(continued.run.baseDocumentVersionId, 'v2');
      assert.equal(run.state.appends, 2);
    } else assert.equal(run.result.run.status, 'completed', run.result.run.errorMessage ?? '');
    assert.equal(mutations, 3);
    const tables = (await native.inspectDocx(run.state.bytes, { focus: { kind: 'tables' } })).tables!.items;
    assert.deepEqual(tables[0]!.rows.map(row => row.cells), [['Name', 'Role'], ['Ada', 'Founder'], ['Lin', 'CTO']]);
    const styles = await inspectDocxStyleSnapshot(run.state.bytes, native);
    assert.equal(styles.styles.find(style => style.styleId === 'Normal')?.effectiveRunFormatting?.color, '235744');
    assert.match(JSON.stringify(styles), /"bold":true/);
    assert.equal(run.state.reports.at(-1)?.outcome, 'success');
    const request = JSON.parse(run.state.modelRequests[20]!);
    request.prompt = request.prompt.filter((message: { content: unknown }) => !JSON.stringify(message.content).includes('CONTINUED ENGINE SESSION'));
    const normalized = JSON.stringify(request).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<runtime-session>');
    assert.match(normalized, /Original|Keep the original facts/);
    assert.match(normalized, /TABLE_ROW_NOT_FOUND/);
    assert.match(normalized, /originalToolCallId/);
    assert.match(normalized, /Founder/);
    assert.doesNotMatch(normalized, /PREVIOUS RUN PROGRESS|"text":"Continue"/);
    t.diagnostic(`PHASE6_CONTINUITY ${JSON.stringify({ bounded, logicalTurns: run.state.modelInputs.length, nativeMutations: mutations,
      savedVersions: run.state.appends, estimatedInputTokens: run.state.estimatedModelInputTokens, peakInputTokens: run.state.peakModelInputTokens })}`);
    return normalized;
  }
  assert.equal(await scenario(true), await scenario(false));
});

test('Phase 6: chained Continue retains each segment once and rejects missing parent state', async () => {
  const inspect = { calls: [{ name: 'document_inspect', input: { kind: 'overview' } }] };
  const run = await runScriptedDocx({ bytes: Buffer.from(buildMinimalDocx(['Unchanged'])), instruction: 'Inspect this document and keep its content unchanged.',
    turns: [{ ...inspect, reasoning: 'Original unfinished objective' }, ...Array.from({ length: 39 }, () => inspect), { text: 'Finished.', calls: [{ name: 'finish', input: {} }] }] });
  assert.equal(run.result.run.errorCode, 'AGENT_MAX_TURNS');
  const second = await (await run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id })).result;
  assert.equal(second.run.errorCode, 'AGENT_MAX_TURNS');
  const segment = run.state.persistence.steps.at(-1)!.output!.continuation as { parentRunId: string; messages: unknown[]; system?: unknown; retrievalMessage?: unknown };
  assert.equal(segment.parentRunId, run.result.run.id);
  assert.equal(segment.messages.length, 40);
  assert.equal(segment.system, undefined);
  assert.equal(segment.retrievalMessage, undefined);
  const done = await (await run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: second.run.id })).result;
  assert.equal(done.run.status, 'completed');
  assert.equal(done.run.triggeringMessageId, run.result.run.triggeringMessageId);
  assert.match(run.state.modelInputs[40]!, /Original unfinished objective/);
  assert.equal(run.state.appends, 0);
  assert.equal(run.state.usage.length, 3);
  await assert.rejects(run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: second.run.id }), /newer execution/);
  // Corrupt the first segment: a missing prefix cannot become a summary-only resume.
  const firstStep = run.state.persistence.steps.find(step => step.runId === run.result.run.id && step.output?.continuation)!;
  delete firstStep.output!.continuation;
  await assert.rejects(run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: second.run.id }), /saved execution context is unavailable/);
});

test('Phase 6: partial batch evidence survives Continue and only matching recovery clears it', async () => {
  const native = await createNapiDocxEngineBinding();
  const texts = ['First', 'Second', 'Third'];
  for (const recover of [false, true]) {
    let failed = false;
    const attempts: string[] = [];
    const binding = { ...native, executeDocxOperation: async (...args: Parameters<NonNullable<typeof native.executeDocxOperation>>) => {
      const target = (args[2].target as { text: string }).text;
      attempts.push(target);
      if (target === 'Second' && !failed) { failed = true; return { result: { ok: false as const, capability: args[1], status: 'error' as const, reasonCode: 'TARGET_NOT_FOUND', changes: [], diagnostics: [] } }; }
      return native.executeDocxOperation!(...args);
    } };
    const operation = (text: string) => ({ target: { text }, bold: true });
    const run = await runScriptedDocx({ binding, bytes: Buffer.from(buildMinimalDocx(texts)), instruction: 'Update this document: bold First, Second, and Third; preserve all wording.', turns: [
      { calls: [{ name: 'capabilities_load', input: { ids: ['document.batch_text_formatting', 'document.set_text_formatting'] } }] },
      { calls: [{ name: 'document_batch_text_formatting', input: { operations: texts.map(operation) } }] },
      ...Array.from({ length: 18 }, () => ({ calls: [{ name: 'document_inspect', input: { kind: 'overview' } }] })),
      { text: 'Finished.', calls: [...(recover ? texts.slice(1).map(text => ({ name: 'document_set_text_formatting', input: operation(text) })) : []), { name: 'finish', input: {} }] },
    ] });
    assert.equal(run.result.run.errorCode, 'AGENT_MAX_TURNS');
    const continued = await (await run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id })).result;
    assert.equal(continued.run.status, recover ? 'completed' : 'failed', continued.run.errorMessage ?? '');
    assert.equal(attempts.filter(target => target === 'First').length, 1);
    assert.deepEqual(attempts, recover ? ['First', 'Second', 'Second', 'Third'] : ['First', 'Second']);
    assert.equal(run.state.appends, recover ? 2 : 1);
    assert.match(run.state.modelInputs[20]!, /failedIndex|TARGET_NOT_FOUND/);
    const saved = await native.inspectDocx(run.state.bytes, { focus: { kind: 'paragraphs' } });
    assert.deepEqual(saved.paragraphs!.items.map(item => item.text), texts);
  }
});

test('Phase 6: 101-target global styling uses two native style changes and preserves emphasis', async (t) => {
  const native = await createNapiDocxEngineBinding();
  const texts = ['Report heading', ...Array.from({ length: 100 }, (_, i) => `Body paragraph ${i}: preserved facts and wording.`)];
  const seed = bindDocxDocument({ binding: native, bytes: buildMinimalDocx(texts) });
  assert.equal((await seed.mutate('set_paragraph_style', { target: { text: texts[0] }, style: 'Heading 1' })).ok, true);
  assert.equal((await seed.mutate('set_text_formatting', { target: { text: texts[1] }, italic: true })).ok, true);
  const before = await inspectDocxStyleSnapshot(seed.currentBytes(), native);
  const turnsFor = (styles: boolean): ScriptedTurn[] => {
    const edits = styles ? ['Normal', 'Heading1'].map(styleId => ({ name: 'document_update_style', input: { styleId, styleType: 'paragraph', fontFamily: 'Calibri', fontSizeHalfPoints: 24, color: '235744' } }))
      : texts.map(text => ({ name: 'document_set_text_formatting', input: { target: { text }, fontFamily: 'Calibri', fontSizeHalfPoints: 24, color: '235744' } }));
    const chunks: ScriptedTurn[] = [];
    for (let i = 0; i < edits.length; i += styles ? 2 : 3) chunks.push({ calls: edits.slice(i, i + (styles ? 2 : 3)) });
    return [{ calls: [{ name: 'capabilities_load', input: { ids: styles ? ['document.style_snapshot', 'document.update_style'] : ['document.style_snapshot', 'document.set_text_formatting'] } }] },
      { calls: [{ name: 'document_style_snapshot', input: {} }] }, ...chunks,
      { text: 'Updated the document appearance.', calls: [{ name: 'finish', input: {} }] }];
  };
  const results: unknown[] = [];
  for (const styles of [false, true]) {
    let mutations = 0;
    const binding = { ...native, executeDocxOperation: async (...args: Parameters<NonNullable<typeof native.executeDocxOperation>>) => {
      mutations++; return native.executeDocxOperation!(...args);
    } };
    const turns = turnsFor(styles);
    const run = await runScriptedDocx({ binding, bytes: Buffer.from(seed.currentBytes()), instruction: 'Format this document: use Calibri 12pt and green text throughout. Preserve all wording, heading levels, and emphasis.', turns });
    let result = run.result;
    if (result.run.errorCode === 'AGENT_MAX_TURNS') result = await (await run.restart().start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: result.run.id })).result;
    assert.equal(result.run.status, 'completed', result.run.errorMessage ?? '');
    assert.equal(mutations, styles ? 2 : 101);
    const snapshot = await inspectDocxStyleSnapshot(run.state.bytes, native);
    const paragraphs = await Promise.all([0, 100].map(offset => native.inspectDocx(run.state.bytes, { focus: { kind: 'paragraphs', offset, limit: 100 } })));
    assert.deepEqual(paragraphs.flatMap(result => result.paragraphs!.items.map(item => item.text)), texts);
    const runs = snapshot.typography.runPatterns;
    assert.ok(runs.every(run => run.effectiveFormatting?.fontFamily === 'Calibri' && run.effectiveFormatting?.fontSizeHalfPoints === 24 && run.effectiveFormatting?.color === '235744'));
    assert.ok(runs.some(run => run.effectiveFormatting?.italic === true));
    assert.equal(snapshot.paragraphPatterns.filter(item => item.styleId === 'Heading1').reduce((sum, item) => sum + item.usageCount, 0),
      before.paragraphPatterns.filter(item => item.styleId === 'Heading1').reduce((sum, item) => sum + item.usageCount, 0));
    const measure = { workflow: styles ? 'native styles' : 'direct overrides', logicalTurns: run.state.modelInputs.length, nativeMutations: mutations,
      redundantMutationAttempts: 0, toolCalls: turns.reduce((sum, turn) => sum + turn.calls.length, 0), generatedArgumentBytes: run.state.generatedArgumentBytes,
      estimatedInputTokens: run.state.estimatedModelInputTokens, peakModelRequestBytes: run.state.peakModelRequestBytes,
      savedVersions: run.state.appends, toolErrors: run.state.reports.reduce((sum, report) => sum + report.tools.filter(tool => tool.outcome === 'failure').length, 0), correct: true };
    results.push(measure);
    t.diagnostic(`PHASE6_BULK ${JSON.stringify(measure)}`);
  }
  assert.equal(results.length, 2);
});

test('Phase 6: attached references, current versions, revoked access, and changed tools stay safe', async () => {
  const native = await createNapiDocxEngineBinding();
  const reference = { id: 'source-1', name: 'Original reference.docx', bytes: Buffer.from(buildMinimalDocx(['Exact reference facts'])) };
  const inspect = { calls: [{ name: 'document_inspect', input: { kind: 'tables' } }] };
  const run = await runScriptedDocx({ binding: native, bytes: await rosterTableDocx(), documentIds: [reference.id], references: [reference],
    instruction: 'Format this document using the attached Original reference.docx as a read-only source; preserve all wording.', turns: [
      { calls: [{ name: 'capabilities_load', input: { ids: ['document.set_text_formatting'] } }] },
      ...Array.from({ length: 19 }, () => inspect),
      { calls: [{ name: 'document_inspect', input: { kind: 'tables' } }] },
      { text: 'Finished the inspection.', calls: [{ name: 'finish', input: {} }] },
    ] });
  const badDocuments = { getOwnedDocument: async () => { throw new Error('deleted or revoked'); } } as unknown as AgentExecutionServiceDeps['documents'];
  await assert.rejects(run.restart({ documents: badDocuments }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id }), /Document not found/);
  assert.equal(run.state.modelInputs.length, 20);
  const changedDraft = { getOwnedDocument: async () => ({ id: 'doc-1', workspaceId: 'ws-1', format: 'docx', latestVersion: { id: 'v1' } }),
    readVersionForEditing: async () => ({ bytes: run.state.bytes, draftId: 'new-human-draft' }),
  } as unknown as AgentExecutionServiceDeps['documents'];
  await assert.rejects(run.restart({ documents: changedDraft }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id }), /draft changed since this task stopped/);
  // An external save changes the runtime version, without altering historical tool evidence.
  run.state.versionId = 'v3';
  run.state.versions.set('v3', Buffer.from(run.state.bytes));
  const capabilities = native.getDocxCapabilities();
  const binding = { ...native, getDocxCapabilities: () => ({ ...capabilities,
    formats: capabilities.formats.map(format => ({ ...format, capabilities: format.capabilities.filter(id => id !== 'set_text_formatting') })),
  }) };
  const resumed = await (await run.restart({ docxBinding: binding }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: run.result.run.id })).result;
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.run.baseDocumentVersionId, 'v3');
  assert.equal(run.state.appends, 0);
  assert.match(run.state.modelInputs[20]!, /Original reference.docx/);
  assert.match(run.state.modelInputs[20]!, /source-1/);
  assert.match(run.state.modelInputs[20]!, /current version: v3/);
  assert.match(run.state.modelInputs[20]!, /boundary: v1/);
  assert.equal(run.state.exposedTools[20]!.includes('document_set_text_formatting'), false);
  const original = JSON.parse(run.state.modelInputs[19]!);
  const continued = JSON.parse(run.state.modelInputs[20]!);
  const tools = (prompt: typeof original) => prompt.filter((message: { role: string }) => message.role === 'assistant' || message.role === 'tool');
  assert.deepEqual(tools(continued).slice(0, tools(original).length), tools(original));
  assert.match(run.state.modelInputs[21]!, /"toolCallId":"21-0","toolName":"document_inspect","output":\{"type":"json","value":\{"ok":true/);
});

const attachmentScope: AttachmentScope = { workspaceId: 'ws-1', userId: 'user-1', threadId: 'thread-1' };
function attachmentFixture(files: { filename: string; bytes: Buffer; mediaType: string }[]) {
  const rows = files.map((file, index): ChatAttachmentDto => ({ id: `attachment-${index}`, ...attachmentScope, filename: file.filename, mediaType: file.mediaType,
    sizeBytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex'), status: 'bound', messageId: 'msg-original', kind: 'file', createdAt: now(), boundAt: now() }));
  const cache = new Map<string, Buffer>();
  let originalReads = 0;
  const source: AttachmentSource = {
    getBound: async (input) => {
      const row = rows.find(row => row.id === input.attachmentId);
      if (input.userId !== attachmentScope.userId || input.workspaceId !== attachmentScope.workspaceId || input.threadId !== attachmentScope.threadId || !row || row.status !== 'bound') throw new ChatAttachmentError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
      return row;
    },
    list: async (input) => input.threadId === attachmentScope.threadId && input.userId === attachmentScope.userId
      ? rows.filter(row => row.status === 'bound' && (input.mentionedIn === undefined || input.mentionedIn.toLowerCase().includes(row.filename.toLowerCase()) || input.mentionedIn.includes(row.id))).slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50)) : [],
    read: async (input) => {
      const meta = await source.getBound({ ...attachmentScope, ...input });
      originalReads++;
      const bytes = files[rows.indexOf(meta)]!.bytes;
      return { ...meta, body: Readable.from([bytes]), contentLength: bytes.length };
    },
    readExtraction: async (input) => { await source.getBound(input); return cache.get(input.attachmentId) ?? null; },
    saveExtraction: async (input) => { await source.getBound(input); cache.set(input.attachmentId, input.bytes); },
  };
  return { source, rows, cache, originalReads: () => originalReads,
    bindToMessage: async (input: { attachmentIds: readonly string[] }) => Promise.all(input.attachmentIds.map(attachmentId => source.getBound({ ...attachmentScope, attachmentId }))), metadataForIds: async () => rows };
}
function attachmentModel(reply: (options: Parameters<NonNullable<MockLanguageModelV4['doStream']>>[0]) => { name: string; input: unknown }[]) {
  let turn = 0;
  return new MockLanguageModelV4({ doStream: async (options) => {
    const calls = reply(options);
    turn++;
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] },
      ...calls.map((call, index) => ({ type: 'tool-call', toolCallId: `attachment-call-${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
      ...(!calls.length ? [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Done.' }, { type: 'text-end', id: 'answer' }] : []),
      { type: 'finish', finishReason: { unified: calls.length ? 'tool-calls' : 'stop', raw: 'stop' }, usage: { inputTokens: { total: 20 }, outputTokens: { total: 4 } } },
    ] as never[] }) };
  } });
}

function attachmentRequest(options: Parameters<NonNullable<MockLanguageModelV4['doStream']>>[0]) {
  const message = options.prompt.find(message => message.role === 'user' && JSON.stringify(message).includes('CHAT ATTACHMENT EVIDENCE'));
  assert.ok(message, 'attachment manifest must be present in the actual provider request');
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join('');
  const manifest = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { attachments: Record<string, any>[]; historyMayBeIncomplete: boolean };
  return { text, manifest };
}

test('attachment first provider request includes small TXT, Markdown and native DOCX tables without retrieval calls; follow-ups reuse extraction', async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const seed = Buffer.from(buildDocxBody([{ kind: 'paragraph', text: 'Launch facts' }, { kind: 'table', rows: [['Metric', 'Value'], ['Budget', '$42,000']] }]));
  const listed = await binding.executeDocxOperation!(seed, 'set_paragraphs_list', { targets: [{ text: 'Launch facts' }], kind: 'bullet' });
  assert.ok(listed.output);
  const original = Buffer.from(listed.output);
  const originalCopy = Buffer.from(original);
  const fixture = attachmentFixture([
    { filename: 'note.txt', bytes: Buffer.from('\ufeffOwner: Mira\r\nShip in June'), mediaType: 'text/plain' },
    { filename: 'plan.md', bytes: Buffer.from('# Plan\n## Schedule\nLaunch is June 12.\n<script>untrusted</script>'), mediaType: 'text/markdown' },
    { filename: 'facts.docx', bytes: original, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ]);
  const extraction = createAttachmentExtractionService(fixture.source, binding);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Attachment checks' });
  let requests = 0;
  const model = attachmentModel(options => {
    const prompt = JSON.stringify(options.prompt);
    assert.match(prompt, /Owner: Mira/);
    assert.match(prompt, /Ship in June/);
    assert.match(prompt, /line:3/);
    assert.match(prompt, /Schedule/);
    assert.match(prompt, /Launch facts/);
    assert.match(prompt, /bullet/);
    assert.match(prompt, /table:1\/row:2\/column:2/);
    assert.match(prompt, /\$42,000/);
    assert.match(prompt, /contentMode\\?":\\?"complete/);
    assert.doesNotMatch(prompt, /metadata only/);
    const { text, manifest } = attachmentRequest(options);
    assert.equal(manifest.attachments.length, 3);
    for (const source of manifest.attachments) {
      assert.ok(source.attachmentId && source.sha256 && source.extractionId);
      assert.ok(source.sizeBytes > 0 && source.extractedCharacters > 0);
      assert.equal(source.contentMode, 'complete');
      assert.equal(source.contentComplete, true);
      assert.equal(source.includedCharacters, source.extractedCharacters);
    }
    const [note, plan, facts] = manifest.attachments;
    assert.equal(note!.format, 'txt');
    assert.equal(note!.title, 'note.txt');
    assert.equal(note!.titleSource, 'filename');
    assert.equal(note!.outline.headingCount, 0);
    assert.deepEqual(note!.outline.headings, []);
    assert.equal(plan!.title, 'Plan');
    assert.equal(plan!.titleSource, 'heading');
    assert.equal(plan!.titleLocation, 'line:1');
    assert.deepEqual(plan!.outline.headings.map((heading: any) => [heading.location, heading.level, heading.section]), [['line:1', 1, ['Plan']], ['line:2', 2, ['Plan', 'Schedule']]]);
    assert.equal(facts!.format, 'docx');
    assert.equal(facts!.title, 'facts.docx');
    assert.equal(facts!.titleSource, 'filename');
    assert.equal(facts!.headingSource, 'main_body');
    assert.equal(facts!.outline.tableCount, 1);
    assert.deepEqual(facts!.outline.tables[0], { location: 'table:1', rows: 2, columns: 2, firstRow: ['Metric', 'Value'] });
    assert.match(text, /Word page headers\/footers are not inspected/);
    if (!requests) t.diagnostic(`ATTACHMENT_SMALL_AWARENESS ${JSON.stringify({ evidenceBytes: Buffer.byteLength(text), providerMessageCharacters: JSON.stringify(options.prompt).length, toolCalls: 0 })}`);
    assert.match(options.prompt.find(message => message.role === 'system')?.content ?? '', /never document IDs or mutation handles/);
    assert.equal(options.tools?.some(tool => 'name' in tool && tool.name === 'attachment_read'), false);
    requests++;
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const execution = createAgentExecutionService({ ...deps, docxBinding: binding, chatAttachments: fixture, attachmentExtraction: extraction });
  const first = await (await execution.start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Read these sources.', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(first.run.status, 'completed');
  assert.equal(persistence.steps.filter(step => step.kind === 'tool').length, 0);
  assert.equal(fixture.originalReads(), 3);
  // A fresh service stands in for a restarted API process: persisted representations are reused.
  const restarted = createAgentExecutionService({ ...deps, docxBinding: binding, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source, binding) });
  const followUp = await (await restarted.start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Use the previous attachments again.' })).result;
  assert.equal(followUp.run.status, 'completed');
  assert.equal(requests, 2);
  assert.equal(fixture.originalReads(), 3);
  assert.equal(persistence.workingDocumentIds.length, 0);
  assert.deepEqual(original, originalCopy);
});

test('large attachment context shares one budget; dynamic search/read retains exact provenance and rejects stale/deleted/cross-chat references', async (t) => {
  const binding = await createNapiDocxEngineBinding();
  let bytes = Buffer.from(buildDocxBody([{ kind: 'paragraph', text: 'Annual facts' },
    ...Array.from({ length: 300 }, (_, index) => ({ kind: 'paragraph' as const, text: index === 240 ? 'Exact launch code: ORCHID-742.' : `Unrelated body ${index}: ${'filler '.repeat(15)}` }))]));
  const styled = await binding.executeDocxSetParagraphStyle(bytes, { target: { text: 'Annual facts' }, style: 'Heading 1' });
  assert.ok(styled.output);
  bytes = Buffer.from(styled.output);
  const fixture = attachmentFixture(Array.from({ length: 4 }, (_, index) => ({ filename: `large-${index}.docx`, bytes, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })));
  const service = createAttachmentExtractionService(fixture.source, binding);
  const evidence = createAttachmentEvidence(service, attachmentScope, fixture.rows.map(row => row.id), 'Find the launch code');
  const context = (await evidence(12_000))!;
  assert.ok(Buffer.byteLength(context) <= 12_000);
  assert.match(context, /Annual facts/);
  assert.match(context, /ORCHID-742/);
  assert.doesNotMatch(context, /Unrelated body 299/);
  assert.equal((context.match(/outline_and_excerpts/g) ?? []).length, 4);
  await assert.rejects(evidence(100), { code: 'ATTACHMENT_CONTEXT_LIMIT' });
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Large source checks' });
  const model = attachmentModel(options => {
    const evidenceMessage = options.prompt.find(message => message.role === 'user' && JSON.stringify(message).includes('CHAT ATTACHMENT EVIDENCE'))!;
    const content = typeof evidenceMessage.content === 'string' ? evidenceMessage.content : evidenceMessage.content.map(part => part.type === 'text' ? part.text : '').join('');
    assert.ok(Buffer.byteLength(content) <= 12_000);
    assert.match(content, /ORCHID-742/);
    assert.doesNotMatch(content, /Unrelated body 299/);
    const { manifest } = attachmentRequest(options);
    for (const source of manifest.attachments) {
      assert.equal(source.title, 'Annual facts');
      assert.equal(source.titleSource, 'heading');
      assert.equal(source.headingSource, 'main_body');
      assert.equal(source.outline.headings[0].location, 'paragraph:1');
      assert.ok(source.extractedCharacters > 30_000);
      assert.ok(source.includedCharacters < source.extractedCharacters);
    }
    t.diagnostic(`ATTACHMENT_MEASUREMENT ${JSON.stringify({ originalDocxBytes: bytes.length * 4, extractedCharacters: [...fixture.cache.values()].reduce((total, value) => total + JSON.parse(value.toString()).units.reduce((sum: number, unit: { text: string }) => sum + unit.text.length, 0), 0), evidenceBytes: Buffer.byteLength(content), attachments: 4, originalReads: fixture.originalReads() })}`);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const run = await (await createAgentExecutionService({ ...deps, docxBinding: binding, chatAttachments: fixture, attachmentExtraction: service }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Find the launch code', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(run.run.status, 'completed');

  const surface = createToolSurface(createAttachmentTools(service, attachmentScope));
  assert.equal(surface.initialTools['attachment.read'], undefined);
  assert.ok(JSON.stringify(surface.session.list('attachment')).includes('attachment.search'));
  assert.equal(surface.session.load(['attachment.search', 'attachment.read', 'attachment.list']).ok, true);
  const tools = surface.session.projectTools();
  const call = async (name: string, args: unknown) => await tools[name]!.execute!(args, {} as never) as Record<string, any>;
  const search = await call('attachment.search', { attachmentIds: [fixture.rows[0]!.id], query: 'ORCHID-742' });
  assert.equal(search.matches[0].location, 'paragraph:242');
  assert.equal(search.matches[0].sha256, fixture.rows[0]!.sha256);
  const reference = { attachmentId: fixture.rows[0]!.id, extractionId: search.matches[0].extractionId, location: search.matches[0].location };
  const read = await call('attachment.read', reference);
  assert.equal(read.complete, true);
  assert.equal(read.content[0].text, 'Exact launch code: ORCHID-742.');
  assert.equal((await call('attachment.read', { ...reference, extractionId: 'stale' })).error.code, 'STALE_EXTRACTION');
  assert.equal((await call('attachment.read', { ...reference, location: 'table:99' })).error.code, 'INVALID_REFERENCE');
  for (const scope of [{ ...attachmentScope, threadId: 'other-chat' }, { ...attachmentScope, userId: 'other-user' }]) {
    const result = await createAttachmentTools(service, scope)['attachment.read']!.execute!(reference, {} as never) as any;
    assert.equal(result.error.code, 'ATTACHMENT_NOT_FOUND');
  }
  fixture.rows[0] = { ...fixture.rows[0]!, status: 'deleted' };
  assert.equal((await call('attachment.read', reference)).error.code, 'ATTACHMENT_NOT_FOUND');
  assert.doesNotMatch((await evidence(12_000))!, /"attachmentId":"attachment-0"/);
  assert.equal(fixture.originalReads(), 4);
});

test('attachment read pagination reconstructs long lines without dropping text', async () => {
  const text = 'Unique long line. '.repeat(900);
  const fixture = attachmentFixture([{ filename: 'long.txt', bytes: Buffer.from(text), mediaType: 'text/plain' }]);
  const service = createAttachmentExtractionService(fixture.source);
  const { extraction } = await service.get(attachmentScope, fixture.rows[0]!.id);
  const tool = createAttachmentTools(service, attachmentScope)['attachment.read']!;
  let next: { offset: number; textOffset: number } | null = { offset: 0, textOffset: 0 };
  let reconstructed = '';
  while (next) {
    const result = await tool.execute!({ attachmentId: fixture.rows[0]!.id, extractionId: extraction.extractionId, ...next }, {} as never) as any;
    assert.equal(result.ok, true);
    assert.ok(JSON.stringify(result).length < 10_000);
    reconstructed += result.content.map((part: any) => part.text).join('');
    next = result.next;
  }
  assert.equal(reconstructed, text);
  assert.equal(fixture.originalReads(), 1);
});

for (const format of ['txt', 'pdf'] as const) test(`attachment ${format} evidence survives a stopped run and Continue with loaded retrieval tools and the original instruction`, async () => {
  const fixture = attachmentFixture([{ filename: `source.${format}`, bytes: format === 'pdf' ? buildTestPdf([['Project code: IRIS-918.']]) : Buffer.from('Project code: IRIS-918.'), mediaType: format === 'pdf' ? 'application/pdf' : 'text/plain' }]);
  const service = createAttachmentExtractionService(fixture.source);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Continue attachments' });
  let turn = 0;
  let reference: { attachmentId: string; extractionId: string; location: string };
  const model = attachmentModel(options => {
    const prompt = JSON.stringify(options.prompt);
    assert.match(prompt, /Use the project code from the source note/);
    assert.match(prompt, /IRIS-918/);
    if (turn++ === 0) {
      const evidenceMessage = options.prompt.find(message => message.role === 'user' && JSON.stringify(message).includes('CHAT ATTACHMENT EVIDENCE'))!;
      const evidenceText = typeof evidenceMessage.content === 'string' ? evidenceMessage.content : evidenceMessage.content.map(part => part.type === 'text' ? part.text : '').join('');
      const evidence = JSON.parse(evidenceText.slice(evidenceText.indexOf('\n') + 1)).attachments[0];
      reference = { attachmentId: evidence.attachmentId, extractionId: evidence.extractionId, location: format === 'pdf' ? 'page:1' : 'line:1' };
      return [{ name: 'capabilities_load', input: { ids: ['attachment.read'] } }];
    }
    assert.ok(options.tools?.some(tool => 'name' in tool && tool.name === 'attachment_read'));
    if (turn === 2) {
      assert.match(prompt, /CONTINUED ENGINE SESSION/);
      return [{ name: 'attachment_read', input: reference }];
    }
    assert.match(prompt, /Project code: IRIS-918/);
    return [];
  });
  const deps = { ...baseDeps(persistence, input => runAgent({ ...input, model, maxTurns: turn === 0 ? 1 : 5 }), undefined, 128_000), chatAttachments: fixture };
  const first = await (await createAgentExecutionService({ ...deps, attachmentExtraction: service }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Use the project code from the source note', attachmentIds: [fixture.rows[0]!.id] })).result;
  assert.equal(first.run.errorCode, 'AGENT_MAX_TURNS');
  const continued = await (await createAgentExecutionService({ ...deps, attachmentExtraction: createAttachmentExtractionService(fixture.source) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Continue', continueFromRunId: first.run.id })).result;
  assert.equal(continued.run.status, 'completed');
  assert.equal(turn, 3);
  assert.equal(fixture.originalReads(), 1);
});

test('scripted provider creates and saves a new native document from DOCX and note attachment evidence', async () => {
  const binding = await createNapiDocxEngineBinding();
  const fixture = attachmentFixture([
    { filename: 'facts.docx', bytes: Buffer.from(buildDocxBody([{ kind: 'paragraph', text: 'Revenue target is $73,500.' }, { kind: 'table', rows: [['Owner', 'Mira']] }])), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { filename: 'note.txt', bytes: Buffer.from('Deliver the report on June 12.'), mediaType: 'text/plain' },
  ]);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Attachment creation' });
  let turn = 0;
  let appends = 0;
  let saved = Buffer.from(binding.createBlankDocx());
  let document = { id: 'new-document', name: 'Combined report.docx', format: 'docx', workspaceId: 'ws-1', latestVersion: { id: 'v1' } };
  const model = attachmentModel(options => {
    assert.match(JSON.stringify(options.prompt), /Revenue target is \$73,500/);
    assert.match(JSON.stringify(options.prompt), /Deliver the report on June 12/);
    assert.match(JSON.stringify(options.prompt), /Mira/);
    if (turn++ === 0) return [{ name: 'workspace_create_blank_document', input: { title: document.name } }];
    if (turn === 2) return [{ name: 'document_insert_paragraphs', input: { placement: { kind: 'end' }, texts: ['Revenue target is $73,500.', 'Owner: Mira.', 'Deliver the report on June 12.'] } }];
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const result = await (await createAgentExecutionService({ ...deps, docxBinding: binding, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source, binding),
    documents: { ...deps.documents, getOwnedDocument: async () => document as never, readExactVersionBytes: async () => saved,
      createBlankDocxDocument: async () => ({ document, version: { id: 'v1', versionNumber: 1 } }) as never,
      appendDocumentVersion: async ({ bytes }) => { appends++; saved = Buffer.from(bytes); document = { ...document, latestVersion: { id: 'v2' } }; return { version: { id: 'v2', versionNumber: 2 } } as never; },
    },
  }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Create a new report using both attached sources.', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(result.run.status, 'completed');
  assert.equal(appends, 1);
  const paragraphs = (await binding.inspectDocx(saved, { focus: { kind: 'paragraphs' } })).paragraphs!.items.map(item => item.text);
  assert.ok(paragraphs.includes('Revenue target is $73,500.'));
  assert.ok(paragraphs.includes('Owner: Mira.'));
  assert.ok(paragraphs.includes('Deliver the report on June 12.'));
  assert.equal(fixture.originalReads(), 2);
  assert.ok(persistence.workingDocumentIds.every(id => !id.startsWith('attachment-')));
});

test('malformed DOCX, invalid text and malformed PDF produce bounded errors without cached success', async () => {
  const binding = await createNapiDocxEngineBinding();
  const corrupt = Buffer.from(buildMinimalDocx(['Unreadable']));
  const payload = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
  corrupt[payload] = corrupt[payload]! ^ 0xff;
  const fixture = attachmentFixture([
    { filename: 'bad.docx', bytes: Buffer.from('PK\x03\x04broken'), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { filename: 'bad.txt', bytes: Buffer.from([0xc3, 0x28]), mediaType: 'text/plain' },
    { filename: 'future.pdf', bytes: Buffer.from('%PDF-future'), mediaType: 'application/pdf' },
    { filename: 'corrupt.docx', bytes: corrupt, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ]);
  const service = createAttachmentExtractionService(fixture.source, binding);
  const tool = createAttachmentTools(service, attachmentScope)['attachment.search']!;
  for (const [index, code] of ['INVALID_DOCX', 'INVALID_ENCODING', 'INVALID_PDF', 'INVALID_DOCX'].entries()) {
    const result = await tool.execute!({ attachmentIds: [fixture.rows[index]!.id], query: 'fact' }, {} as never) as any;
    assert.equal(result.error.code, code);
  }
  fixture.rows[0] = { ...fixture.rows[0]!, status: 'staged' };
  await assert.rejects(service.get(attachmentScope, fixture.rows[0]!.id), { code: 'ATTACHMENT_NOT_FOUND' });
  assert.equal(fixture.cache.size, 0);
});

test('attachment context guard preserves the instruction and fails clearly before a provider request if current identities cannot fit', async () => {
  const fixture = attachmentFixture([{ filename: 'source.txt', bytes: Buffer.from('Optional private evidence'), mediaType: 'text/plain' }]);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Budget check' });
  const instruction = 'Keep this exact instruction: ' + 'Every user word must remain. '.repeat(80);
  let requests = 0;
  const model = attachmentModel(() => { requests++; return []; });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 1_024);
  const result = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source) }).start({ userId: 'user-1', threadId: 'thread-1', instruction, attachmentIds: [fixture.rows[0]!.id] })).result;
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.errorCode, 'ATTACHMENT_CONTEXT_LIMIT');
  assert.match(result.run.errorMessage!, /all current attachment identities/);
  assert.equal(result.userMessage.content, instruction);
  assert.equal(requests, 0);
  assert.equal(fixture.originalReads(), 0);
});

test('cached unrelated attachments are omitted while a named previous note is supplied directly', async () => {
  const fixture = attachmentFixture([
    { filename: 'payroll.txt', bytes: Buffer.from('Private payroll material.'), mediaType: 'text/plain' },
    { filename: 'launch.txt', bytes: Buffer.from('The launch opens in June.'), mediaType: 'text/plain' },
  ]);
  const service = createAttachmentExtractionService(fixture.source);
  await service.get(attachmentScope, fixture.rows[0]!.id);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Relevant source check' });
  const model = attachmentModel(options => {
    assert.match(JSON.stringify(options.prompt), /The launch opens in June/);
    assert.doesNotMatch(JSON.stringify(options.prompt), /Private payroll material|payroll.txt/);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const result = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: service }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Summarize launch.txt.' })).result;
  assert.equal(result.run.status, 'completed');
});

test('initial provider manifest retains ten current identities and bounds large outlines, including extraction failures', async (t) => {
  const body = Array.from({ length: 120 }, (_, index) => `## Section ${index}\n${'Detailed source text. '.repeat(20)}`).join('\n');
  const fixture = attachmentFixture(Array.from({ length: 10 }, (_, index) => index === 0
    ? { filename: 'invalid.txt', bytes: Buffer.from([0xc3, 0x28]), mediaType: 'text/plain' }
    : { filename: `outline-${index}.md`, bytes: Buffer.from(`# Source ${index}\n${body}`), mediaType: 'text/markdown' }));
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'All sources' });
  const model = attachmentModel(options => {
    const { text, manifest } = attachmentRequest(options);
    assert.ok(Buffer.byteLength(text) <= 12_000);
    assert.deepEqual(manifest.attachments.map(source => source.attachmentId), fixture.rows.map(row => row.id));
    for (const [index, source] of manifest.attachments.entries()) {
      assert.equal(source.filename, fixture.rows[index]!.filename);
      assert.equal(source.sha256, fixture.rows[index]!.sha256);
      assert.equal(source.sizeBytes, fixture.rows[index]!.sizeBytes);
      assert.equal(source.source, 'current');
      if (!index) {
        assert.equal(source.format, 'txt');
        assert.equal(source.error.code, 'INVALID_ENCODING');
        assert.equal(source.titleSource, 'filename');
        assert.equal(source.contentMode, 'unavailable');
      } else {
        assert.equal(source.title, `Source ${index}`);
        assert.equal(source.outline.headingCount, 121);
        assert.equal(source.outline.tableCount, 0);
        assert.ok(source.outline.headings.length >= 1 && source.outline.headings.length <= 24);
        assert.ok(source.outline.remainingHeadings > 0);
        assert.ok(source.extractionId);
        assert.equal(source.contentComplete, false);
        assert.equal(source.content, undefined);
      }
    }
    t.diagnostic(`ATTACHMENT_TEN_SOURCE_AWARENESS ${JSON.stringify({ evidenceBytes: Buffer.byteLength(text), attachments: manifest.attachments.length, toolCalls: 0 })}`);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const result = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Describe the attached sources.', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(result.run.status, 'completed');
  assert.equal(persistence.steps.filter(step => step.kind === 'tool').length, 0);
});

test('initial provider manifest includes a named older source beyond recent history even with ten current attachments', async () => {
  const fixture = attachmentFixture(Array.from({ length: 72 }, (_, index) => ({ filename: index < 10 ? `new-${index}.txt` : `old-note-${index}.txt`, bytes: Buffer.from(`Fact for source ${index}.`), mediaType: 'text/plain' })));
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Older named source' });
  const model = attachmentModel(options => {
    const { manifest } = attachmentRequest(options);
    assert.equal(manifest.attachments.length, 11);
    assert.deepEqual(manifest.attachments.filter(source => source.source === 'current').map(source => source.attachmentId), fixture.rows.slice(0, 10).map(row => row.id));
    const earlier = manifest.attachments.find(source => source.attachmentId === fixture.rows[65]!.id)!;
    assert.equal(earlier.source, 'previous');
    assert.equal(earlier.title, 'old-note-65.txt');
    assert.equal(earlier.titleSource, 'filename');
    assert.ok(earlier.extractionId);
    assert.equal(manifest.historyMayBeIncomplete, true);
    assert.doesNotMatch(JSON.stringify(manifest), /old-note-64.txt/);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const result = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Use the new sources with OLD-NOTE-65.TXT.', attachmentIds: fixture.rows.slice(0, 10).map(row => row.id) })).result;
  assert.equal(result.run.status, 'completed');
  assert.equal(fixture.originalReads(), 11, 'unrelated older source bodies are never inspected');
});

test('scripted large-source task loads search/read directly from the manifest without listing or confirming known structure', async (t) => {
  const fixture = attachmentFixture([{ filename: 'launch.md', mediaType: 'text/markdown', bytes: Buffer.from('# Launch Plan\n## Budget\n' + 'Cost item: 100 units.\n'.repeat(200) + '## Deployment\nIssued value: VIOLET-204.\n') }]);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Targeted attachment retrieval' });
  let turn = 0;
  let reference: { attachmentId: string; extractionId: string; location: string; section: boolean; limit: number };
  const model = attachmentModel(options => {
    if (turn++ === 0) {
      const { text, manifest } = attachmentRequest(options);
      const source = manifest.attachments[0]!;
      assert.equal(source.title, 'Launch Plan');
      const budget = source.outline.headings.find((heading: any) => heading.title === 'Budget');
      assert.ok(budget);
      assert.doesNotMatch(text, /VIOLET-204/);
      reference = { attachmentId: source.attachmentId, extractionId: source.extractionId, location: budget.location, section: true, limit: 2 };
      return [{ name: 'capabilities_load', input: { ids: ['attachment.search', 'attachment.read'] } }];
    }
    assert.equal(options.tools?.some(tool => 'name' in tool && tool.name === 'attachment_list'), false);
    if (turn === 2) return [
      { name: 'attachment_read', input: reference },
      { name: 'attachment_search', input: { attachmentIds: [reference.attachmentId], query: 'Issued value' } },
    ];
    const results = JSON.stringify(options.prompt.filter(message => message.role === 'tool'));
    assert.match(results, /Cost item: 100 units/);
    assert.match(results, /VIOLET-204/);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const result = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: createAttachmentExtractionService(fixture.source) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Summarize Budget and give the access credential.', attachmentIds: [fixture.rows[0]!.id] })).result;
  assert.equal(result.run.status, 'completed');
  const calls = persistence.steps.filter(step => step.kind === 'tool').map(step => step.name);
  assert.deepEqual(calls, ['capabilities.load', 'attachment.read', 'attachment.search']);
  assert.equal(fixture.originalReads(), 1);
  t.diagnostic(`ATTACHMENT_TARGETED_AWARENESS ${JSON.stringify({ providerRequests: turn, toolCalls: calls.length, attachmentListCalls: 0, capabilityListOrSearchCalls: 0, originalReads: fixture.originalReads() })}`);
});

test('PDF small digital pages arrive complete in the first provider request alongside DOCX and TXT, with no tools and cached follow-ups', async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = buildTestPdf([['Quarterly results', 'Revenue $42,750; margin 18.5%.'], ['Next quarter plan', 'Owner Mira; launch June 12.']], { title: 'Quarterly results', structure: true });
  const original = Buffer.from(bytes);
  const fixture = attachmentFixture([
    { filename: 'quarter.pdf', bytes, mediaType: 'application/pdf' },
    { filename: 'note.txt', bytes: Buffer.from('Approved by Priya.'), mediaType: 'text/plain' },
    { filename: 'facts.docx', bytes: Buffer.from(buildMinimalDocx(['Budget is $9,200.'])), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ]);
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'PDF source checks' });
  let requests = 0;
  const model = attachmentModel(options => {
    const { text, manifest } = attachmentRequest(options);
    assert.ok(Buffer.byteLength(text) <= 12_000);
    assert.deepEqual(manifest.attachments.map(item => item.attachmentId), fixture.rows.map(row => row.id));
    const pdf = manifest.attachments[0]!;
    assert.equal(pdf.title, 'Quarterly results');
    assert.equal(pdf.titleSource, 'pdf_metadata');
    assert.equal(pdf.format, 'pdf');
    assert.equal(pdf.pageCount, 2);
    assert.equal(pdf.extractionStatus, 'ready');
    assert.match(pdf.extractor, /pdfjs-5\.6\.205/);
    assert.equal(pdf.sha256, fixture.rows[0]!.sha256);
    assert.equal(pdf.contentMode, 'complete');
    assert.equal(pdf.contentComplete, true);
    assert.equal(pdf.outline.headingCount, 0);
    assert.equal(pdf.outline.tableCount, 0);
    assert.equal(pdf.outline.bookmarks.length, 2);
    assert.equal(pdf.outline.bookmarks[1].location, 'page:2');
    assert.deepEqual(pdf.content.map((unit: any) => [unit.location, unit.page.number, unit.page.label, unit.page.textStatus]), [['page:1', 1, 'i', 'digital_text'], ['page:2', 2, '1', 'digital_text']]);
    assert.match(pdf.content[0].text, /Revenue \$42,750; margin 18.5%/);
    assert.match(pdf.content[1].text, /Owner Mira; launch June 12/);
    assert.equal(pdf.content[0].page.width, 612);
    for (const source of manifest.attachments) assert.equal(source.contentComplete, true);
    if (!requests++) t.diagnostic(`PDF_SMALL ${JSON.stringify({ originalBytes: bytes.length, evidenceBytes: Buffer.byteLength(text), toolCalls: 0 })}`);
    return [];
  });
  const deps = { ...baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000), docxBinding: binding, chatAttachments: fixture };
  const start = performance.now();
  const run = await (await createAgentExecutionService({ ...deps, attachmentExtraction: createAttachmentExtractionService(fixture.source, binding) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Summarize these sources.', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(run.run.status, 'completed');
  const elapsed = performance.now() - start;
  const cachedStart = performance.now();
  const followUp = await (await createAgentExecutionService({ ...deps, attachmentExtraction: createAttachmentExtractionService(fixture.source, binding) }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Use the previous attachments again.' })).result;
  assert.equal(followUp.run.status, 'completed');
  assert.equal(requests, 2);
  assert.equal(fixture.originalReads(), 3);
  assert.equal(persistence.steps.filter(step => step.kind === 'tool').length, 0);
  assert.deepEqual(bytes, original);
  t.diagnostic(`PDF_SMALL_TIME ${JSON.stringify({ firstRunMs: Math.round(elapsed), cachedRunMs: Math.round(performance.now() - cachedStart) })}`);
});

test('PDF large source is bounded in the actual provider request; paged lexical search and page/range reads preserve numeric evidence', async (t) => {
  const pages = Array.from({ length: 80 }, (_, index) => [
    `Annual report physical page ${index + 1}`,
    ...Array.from({ length: 30 }, (_, line) => `Region ${line + 1} revenue $12,345.60; cost $9,876.50; units 123.`),
    ...(index === 66 ? ['Verification code: CEDAR-672.'] : []),
  ]);
  const bytes = buildTestPdf(pages, { title: 'Annual report', structure: true });
  const fixture = attachmentFixture([
    { filename: 'annual.pdf', bytes, mediaType: 'application/pdf' },
    { filename: 'tiny.txt', bytes: Buffer.from('Tiny source is fully included.'), mediaType: 'text/plain' },
  ]);
  const service = createAttachmentExtractionService(fixture.source);
  const started = performance.now();
  const { extraction } = await service.get(attachmentScope, fixture.rows[0]!.id);
  const extractionMs = performance.now() - started;
  const tools = createAttachmentTools(service, attachmentScope);
  const call = async (name: string, args: unknown) => await tools[name]!.execute!(args, {} as never) as Record<string, any>;
  const search = await call('attachment.search', { attachmentIds: fixture.rows.map(row => row.id), query: 'CEDAR-672' });
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].location, 'page:67');
  assert.equal(search.matches[0].page.number, 67);
  assert.equal(search.matches[0].page.label, '66');
  assert.equal(search.matches[0].sha256, fixture.rows[0]!.sha256);
  assert.ok(search.matches[0].textOffset > 0);
  const reference = { attachmentId: fixture.rows[0]!.id, extractionId: extraction.extractionId, location: 'page:67' };
  const read = await call('attachment.read', reference);
  assert.equal(read.content.length, 1);
  assert.match(read.content[0].text, /\$12,345\.60; cost \$9,876\.50; units 123/);
  assert.equal(read.content[0].headingLevel, undefined);
  assert.match(read.limitations.join(' '), /Tabular structure.*incomplete/);
  const range = await call('attachment.read', { ...reference, location: 'page:66', pageEnd: 68 });
  assert.deepEqual(range.content.map((unit: any) => unit.location), ['page:66', 'page:67']);
  assert.ok(range.next);
  const rangeEnd = await call('attachment.read', { ...reference, location: 'page:66', pageEnd: 68, ...range.next });
  assert.deepEqual(rangeEnd.content.map((unit: any) => unit.location), ['page:68']);
  assert.equal(rangeEnd.next, null);
  let nextOffset: number | null = 0;
  const locations: string[] = [];
  while (nextOffset !== null) {
    const page = await call('attachment.search', { attachmentIds: [fixture.rows[0]!.id], query: 'revenue', limit: 3, offset: nextOffset });
    assert.equal(page.ok, true);
    assert.ok(JSON.stringify(page).length <= 8_000);
    locations.push(...page.matches.map((match: any) => match.location));
    assert.ok(page.nextOffset === null || page.nextOffset > nextOffset);
    nextOffset = page.nextOffset;
  }
  assert.equal(locations.length, 80);
  assert.equal(new Set(locations).size, 80);
  assert.equal((await call('attachment.read', { ...reference, pageEnd: 1 })).error.code, 'INVALID_REFERENCE');
  assert.equal((await call('attachment.read', { ...reference, extractionId: 'old' })).error.code, 'STALE_EXTRACTION');
  const persistence = memoryPersistence('user-1');
  const thread = await persistence.getOwnedThread({ threadId: 'thread-1', ownerUserId: 'user-1' });
  persistence.getOwnedThread = async () => ({ ...thread!, title: 'Large PDF checks' });
  const model = attachmentModel(options => {
    const { text, manifest } = attachmentRequest(options);
    const pdf = manifest.attachments[0]!;
    assert.ok(Buffer.byteLength(text) <= 12_000);
    assert.equal(pdf.pageCount, 80);
    assert.equal(pdf.contentComplete, false);
    assert.equal(pdf.title, 'Annual report');
    assert.equal(pdf.content, undefined);
    assert.ok(pdf.outline.bookmarks.length > 0);
    assert.match(text, /CEDAR-672/);
    assert.doesNotMatch(text, /Annual report physical page 79/);
    assert.equal(manifest.attachments[1]!.contentComplete, true);
    t.diagnostic(`PDF_LARGE ${JSON.stringify({ originalBytes: bytes.length, extractedCharacters: extraction.units.reduce((sum, unit) => sum + unit.text.length, 0), extractionMs: Math.round(extractionMs), cacheBytes: fixture.cache.get(fixture.rows[0]!.id)!.length, evidenceBytes: Buffer.byteLength(text), pages: 80 })}`);
    return [];
  });
  const deps = baseDeps(persistence, input => runAgent({ ...input, model }), undefined, 128_000);
  const run = await (await createAgentExecutionService({ ...deps, chatAttachments: fixture, attachmentExtraction: service }).start({ userId: 'user-1', threadId: 'thread-1', instruction: 'Give the verification code.', attachmentIds: fixture.rows.map(row => row.id) })).result;
  assert.equal(run.run.status, 'completed');
  assert.equal(fixture.originalReads(), 2);
});

test('PDF mixed image/text pages, failures, limits and authorization never invent missing content', async () => {
  const damaged = buildTestPdf([['Healthy digital page with values 12345.'], ['Damaged text stream']]);
  const marker = Buffer.from('/Filter /FlateDecode >>\nstream\n');
  const damagedStart = damaged.indexOf(marker, damaged.indexOf(marker) + 1) + marker.length;
  damaged.fill(0, damagedStart, damagedStart + 8);
  const fixture = attachmentFixture([
    { filename: 'mixed.pdf', bytes: buildTestPdf([['Digital report and extracted values 12345.'], null, ['7']]), mediaType: 'application/pdf' },
    { filename: 'encrypted.pdf', bytes: buildTestPdf([['Private values']], { encrypted: true }), mediaType: 'application/pdf' },
    { filename: 'corrupt.pdf', bytes: Buffer.from('%PDF-1.7\ncorrupt body'), mediaType: 'application/pdf' },
    { filename: 'pretend.pdf', bytes: Buffer.from('not a PDF'), mediaType: 'application/pdf' },
    { filename: 'huge.pdf', bytes: buildTestPdf(Array.from({ length: 501 }, () => ['Bounded pages'])), mediaType: 'application/pdf' },
    { filename: 'partial.pdf', bytes: buildTestPdf(Array.from({ length: 300 }, () => Array.from({ length: 40 }, () => 'i'.repeat(100)))), mediaType: 'application/pdf' },
    { filename: 'damaged-page.pdf', bytes: damaged, mediaType: 'application/pdf' },
  ]);
  const service = createAttachmentExtractionService(fixture.source);
  const { extraction } = await service.get(attachmentScope, fixture.rows[0]!.id);
  assert.deepEqual(extraction.units.map(unit => unit.page?.textStatus), ['digital_text', 'no_text', 'limited_text']);
  assert.equal(extraction.pdf?.title, undefined);
  assert.deepEqual(extraction.pdf?.outline, []);
  assert.match(extraction.units[1]!.page!.warnings.join(' '), /not call it blank/);
  const tools = createAttachmentTools(service, attachmentScope);
  const ref = { attachmentId: fixture.rows[0]!.id, extractionId: extraction.extractionId, location: 'page:2' };
  const imageRead = await tools['attachment.read']!.execute!(ref, {} as never) as any;
  assert.equal(imageRead.ok, true);
  assert.equal(imageRead.content[0].text, '');
  assert.equal(imageRead.content[0].page.textStatus, 'no_text');
  for (const [index, code] of [[1, 'PDF_PASSWORD_REQUIRED'], [2, 'INVALID_PDF'], [3, 'INVALID_PDF'], [4, 'EXTRACTION_LIMIT']] as const) {
    await assert.rejects(service.get(attachmentScope, fixture.rows[index]!.id), { code });
    assert.equal(fixture.cache.has(fixture.rows[index]!.id), false);
  }
  const damagedResult = await service.get(attachmentScope, fixture.rows[6]!.id);
  assert.equal(damagedResult.extraction.pdf!.complete, false);
  assert.deepEqual(damagedResult.extraction.units.map(unit => unit.page!.textStatus), ['digital_text', 'failed']);
  const { extraction: partial } = await service.get(attachmentScope, fixture.rows[5]!.id);
  assert.equal(partial.pdf!.complete, false);
  assert.equal(partial.pdf!.pageCount, 300);
  assert.ok(partial.pdf!.processedPages > 0 && partial.pdf!.processedPages < 300);
  assert.match(partial.limitations.join(' '), /Omitted pages\/text are unavailable, not empty/);
  const omitted = await tools['attachment.read']!.execute!({ attachmentId: fixture.rows[5]!.id, extractionId: partial.extractionId, location: 'page:300' }, {} as never) as any;
  assert.equal(omitted.error.code, 'PDF_PAGE_UNAVAILABLE');
  let next: { offset: number; textOffset: number } | null = { offset: 0, textOffset: 0 };
  let text = '';
  while (next) {
    const result = await tools['attachment.read']!.execute!({ attachmentId: partial.attachmentId, extractionId: partial.extractionId, location: 'page:1', ...next }, {} as never) as any;
    assert.ok(JSON.stringify(result).length <= 8_000);
    text += result.content[0].text;
    next = result.next;
  }
  assert.equal(text, partial.units[0]!.text);
  for (const scope of [{ ...attachmentScope, userId: 'other' }, { ...attachmentScope, threadId: 'other' }]) {
    const result = await createAttachmentTools(service, scope)['attachment.read']!.execute!(ref, {} as never) as any;
    assert.equal(result.error.code, 'ATTACHMENT_NOT_FOUND');
  }
  fixture.rows[0] = { ...fixture.rows[0]!, status: 'staged' };
  await assert.rejects(service.get(attachmentScope, ref.attachmentId), { code: 'ATTACHMENT_NOT_FOUND' });
  fixture.rows[0] = { ...fixture.rows[0]!, status: 'deleted' };
  const deleted = await tools['attachment.read']!.execute!(ref, {} as never) as any;
  assert.equal(deleted.error.code, 'ATTACHMENT_NOT_FOUND');
});

test('PDF ten-source evidence keeps every current identity and page count while a small TXT remains complete', async (t) => {
  const bytes = buildTestPdf(Array.from({ length: 8 }, (_, index) => [`Source page ${index + 1}`, 'Revenue and costs: 12345. '.repeat(15)]), { structure: true });
  const fixture = attachmentFixture(Array.from({ length: 10 }, (_, index) => index === 9
    ? { filename: 'tiny.txt', bytes: Buffer.from('Keep this small note complete.'), mediaType: 'text/plain' }
    : { filename: `source-${index}.pdf`, bytes, mediaType: 'application/pdf' }));
  const service = createAttachmentExtractionService(fixture.source);
  const text = (await createAttachmentEvidence(service, attachmentScope, fixture.rows.map(row => row.id), 'Summarize the attached sources.')(12_000))!;
  const manifest = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.ok(Buffer.byteLength(text) <= 12_000);
  assert.deepEqual(manifest.attachments.map((source: any) => source.attachmentId), fixture.rows.map(row => row.id));
  for (const source of manifest.attachments.slice(0, 9)) {
    assert.equal(source.pageCount, 8);
    assert.equal(source.titleSource, 'filename');
    assert.equal(source.extractionStatus, 'ready');
    assert.ok(source.extractionId && source.sha256);
  }
  assert.equal(manifest.attachments[9].contentComplete, true);
  t.diagnostic(`PDF_TEN_SOURCES ${JSON.stringify({ evidenceBytes: Buffer.byteLength(text), currentIds: manifest.attachments.length })}`);
});
