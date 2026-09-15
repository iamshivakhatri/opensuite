import {
  createFinishTool,
  isSuccessfulStop,
  runAgent,
  type AgentEvent as CoreAgentEvent,
  type AgentToolSet,
  type ModelMessage,
  type StopReason,
  type V3Model,
} from "@opensuite/agent-core-v3";

import type { DocxEngineBinding } from "@opensuite/engine-client";

import type { CredentialSource } from "../ai-preferences/types.js";
import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { DocumentService } from "../documents/service.js";
import type { ManagedTrialService } from "../managed-trial/service.js";
import type { ModelUsageService } from "../model-usage/service.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { buildAgentOperatingInstruction } from "./operating-instruction.js";
import {
  type AgentMessage,
  type AgentPersistenceService,
  type AgentRun,
  type AgentThread,
} from "./persistence.js";
import {
  AGENT_EXECUTION_LEASE_RENEW_MS,
  type AgentExecutionLease,
  type AgentExecutionLeaseService,
} from "./execution-lease.js";

export type AgentEvent =
  | { readonly type: "agent.started"; readonly runId: string; readonly at: string }
  | { readonly type: "message.delta"; readonly runId: string; readonly messageId: string; readonly delta: string; readonly at: string }
  | { readonly type: "message.completed"; readonly runId: string; readonly messageId: string; readonly content: string; readonly at: string }
  | { readonly type: "tool.started"; readonly runId: string; readonly at: string; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool.completed"; readonly runId: string; readonly at: string; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool.failed"; readonly runId: string; readonly at: string; readonly toolCallId: string; readonly toolName: string; readonly error: string }
  | {
      readonly type: "document.version.advanced";
      readonly runId: string;
      readonly at: string;
      readonly documentId: string;
      readonly versionId: string;
      readonly versionNumber: number;
    }
  | { readonly type: "agent.completed"; readonly runId: string; readonly at: string }
  | { readonly type: "agent.cancelled"; readonly runId: string; readonly at: string }
  | { readonly type: "agent.failed"; readonly runId: string; readonly at: string; readonly code: string };

export interface AgentEventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

export interface AgentModelUsageAttribution {
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly credentialSource: CredentialSource;
}

export interface ResolvedV3ExecutionModel {
  readonly model: V3Model;
  readonly usageAttribution?: AgentModelUsageAttribution;
}

/** @deprecated Use ResolvedV3ExecutionModel — alias during V3 cutover. */
export type ResolvedV2ExecutionModel = ResolvedV3ExecutionModel;

export type AgentExecutionErrorCode =
  | "THREAD_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "AI_CONFIGURATION_INVALID"
  | "AGENT_EXECUTION_BUSY"
  | "AGENT_EXECUTION_FAILED"
  | "AGENT_PERSISTENCE_FAILED";

export class AgentExecutionError extends Error {
  constructor(readonly code: AgentExecutionErrorCode, message: string) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

export interface AgentExecutionInput {
  readonly userId: string;
  readonly threadId: string;
  readonly instruction: string;
  readonly documentIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
}

export interface AgentExecutionResult {
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly assistantMessage: AgentMessage | null;
}

export interface AgentExecutionHandle {
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly result: Promise<AgentExecutionResult>;
}

export interface AgentExecutionServiceDeps {
  readonly persistence: AgentPersistenceService;
  readonly documents: Pick<
    DocumentService,
    "getOwnedDocument" | "readExactVersionBytes" | "appendDocumentVersion"
  >;
  readonly resolveModel: (userId: string) => Promise<ResolvedV3ExecutionModel>;
  readonly docxBinding?: DocxEngineBinding;
  readonly modelUsage?: ModelUsageService;
  readonly managedTrial?: ManagedTrialService;
  readonly lease?: AgentExecutionLeaseService;
  /** Test seam — production uses agent-core-v3 `runAgent`. */
  readonly runAgent?: typeof runAgent;
}

/** Product shell: resolve and persist here; execute once in agent-core-v3. */
export function createAgentExecutionService(deps: AgentExecutionServiceDeps) {
  async function start(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    const thread = await deps.persistence.getOwnedThread({
      threadId: input.threadId,
      ownerUserId: input.userId,
    });
    if (!thread) {
      throw new AgentExecutionError("THREAD_NOT_FOUND", "Agent thread not found");
    }

    const lease = await deps.lease?.acquire(input.userId);
    if (deps.lease && !lease) {
      throw new AgentExecutionError("AGENT_EXECUTION_BUSY", "Another agent execution is already active.");
    }

    try {
      const model = await resolveModel(deps, input.userId);
      const primaryDocument = await resolvePrimaryDocument(
        deps.documents,
        thread,
        input.userId,
        input.documentIds,
      );
      const started = await deps.persistence.withTransaction(async (tx) => {
        const userMessage = await deps.persistence.appendMessage(
          { threadId: thread.id, ownerUserId: input.userId, role: "user", content: input.instruction },
          tx,
        );
        const run = await deps.persistence.createRun(
          {
            threadId: thread.id,
            ownerUserId: input.userId,
            createdByUserId: input.userId,
            triggeringMessageId: userMessage.id,
            baseDocumentVersionId: primaryDocument?.versionId ?? null,
            status: "queued",
          },
          tx,
        );
        return { userMessage, run };
      });

      console.info(`[agent] runtime=v3 run=${started.run.id.slice(0, 8)}`);
      const result = runExecution({
        deps,
        model,
        thread,
        userMessage: started.userMessage,
        run: started.run,
        primaryDocumentId: primaryDocument?.documentId ?? null,
        ownerUserId: input.userId,
        instruction: input.instruction,
        signal: input.signal,
        liveEvents: input.liveEvents,
      });
      // Background observation/ownership lives in run-manager (not here).
      const protectedResult = lease
        ? keepLeaseUntilFinished(deps.lease!, lease, result)
        : result;
      return { thread, userMessage: started.userMessage, run: started.run, result: protectedResult };
    } catch (error) {
      if (lease) await releaseLease(deps.lease!, lease);
      throw error;
    }
  }

  async function execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return (await start(input)).result;
  }

  return { start, execute };
}

async function resolveModel(
  deps: AgentExecutionServiceDeps,
  userId: string,
): Promise<ResolvedV3ExecutionModel> {
  try {
    return await deps.resolveModel(userId);
  } catch (error) {
    throw new AgentExecutionError(
      "AI_CONFIGURATION_INVALID",
      error instanceof Error ? error.message : "AI configuration is unavailable",
    );
  }
}

async function resolvePrimaryDocument(
  documents: Pick<DocumentService, "getOwnedDocument">,
  thread: AgentThread,
  userId: string,
  documentIds: readonly string[] | undefined,
): Promise<{ documentId: string; versionId: string } | null> {
  const documentId = documentIds?.[0] ?? thread.documentId;
  if (!documentId) return null;
  try {
    const document = await documents.getOwnedDocument({ documentId, ownerUserId: userId });
    if (document.workspaceId !== thread.workspaceId) {
      throw new AgentExecutionError("DOCUMENT_NOT_FOUND", "Document is not in this workspace");
    }
    return { documentId, versionId: document.latestVersion.id };
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError("DOCUMENT_NOT_FOUND", "Document not found for agent run");
  }
}

async function runExecution(input: {
  readonly deps: AgentExecutionServiceDeps;
  readonly model: ResolvedV3ExecutionModel;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly primaryDocumentId: string | null;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
}): Promise<AgentExecutionResult> {
  const priorMessages = await input.deps.persistence.listMessagesForThread({
    threadId: input.thread.id,
    ownerUserId: input.ownerUserId,
  });
  const messages: ModelMessage[] = [
    ...priorMessages
      .filter((message) => message.id !== input.userMessage.id)
      .map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: input.instruction },
  ];
  const messageId = `v3-${input.run.id}`;

  try {
    await input.deps.persistence.updateRunStatus({
      runId: input.run.id,
      ownerUserId: input.ownerUserId,
      status: "running",
    });
    const runShort = input.run.id.slice(0, 8);
    console.info(
      `[agent-v3] run_start run=${runShort} provider=openrouter model=${input.model.usageAttribution?.model ?? "unknown"}`,
    );
    if (
      input.model.usageAttribution?.provider === "openrouter" &&
      input.model.usageAttribution.credentialSource === "managed"
    ) {
      await input.deps.managedTrial?.beforeManagedCall(input.ownerUserId);
    }

    const boundTools = await createPrimaryDocxTools({
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      documentId: input.primaryDocumentId,
      versionId: input.run.baseDocumentVersionId,
      onVersionAdvanced: async (advanced) => {
        await input.liveEvents?.emit({
          type: "document.version.advanced",
          runId: input.run.id,
          at: new Date().toISOString(),
          documentId: advanced.documentId,
          versionId: advanced.versionId,
          versionNumber: advanced.versionNumber,
        });
      },
    });

    const finish = createFinishTool({
      description: "Call when the requested work is complete. Ends the run.",
    });
    const tools: AgentToolSet = {
      ...(boundTools?.tools ?? {}),
      [finish.name]: finish.tool,
    };

    // The one API → agent-core-v3 execution call.
    const executeAgent = input.deps.runAgent ?? runAgent;
    const result = await executeAgent({
      model: input.model.model,
      system: buildAgentOperatingInstruction(Object.keys(tools)),
      messages,
      tools,
      signal: input.signal,
      runId: runShort,
      onEvent: (event) => relayEvent(event, input.liveEvents, input.run.id, messageId),
    });

    if (!isSuccessfulStop(result.stopReason)) {
      return settleTerminalRunFailure({
        error: new Error(`Agent stopped: ${result.stopReason}`),
        cancelled: input.signal?.aborted === true,
        persistence: input.deps.persistence,
        ownerUserId: input.ownerUserId,
        thread: input.thread,
        userMessage: input.userMessage,
        run: input.run,
        liveEvents: input.liveEvents,
        failureCode: failureCodeForStopReason(result.stopReason),
        failureMessage: `Agent stopped with ${result.stopReason}`,
      });
    }

    if (input.deps.modelUsage && input.model.usageAttribution) {
      const usage = await input.deps.modelUsage.recordFromProviderResponse({
        attribution: { ...input.model.usageAttribution, userId: input.ownerUserId, agentRunId: input.run.id },
        usage: result,
      });
      if (
        input.model.usageAttribution.provider === "openrouter" &&
        input.model.usageAttribution.credentialSource === "managed"
      ) {
        await input.deps.managedTrial?.applyManagedUsage(usage);
      }
    }

    const finalized = await finalizeCompletedRun({
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      threadId: input.thread.id,
      runId: input.run.id,
      content: result.text,
    });
    await input.liveEvents?.emit({ type: "agent.completed", runId: input.run.id, at: new Date().toISOString() });
    return { thread: input.thread, userMessage: input.userMessage, ...finalized };
  } catch (error) {
    // Convert every run failure into terminal product state and settle normally.
    // Re-throwing here used to reject the background promise; combined with an
    // unobserved Promise.finally in run-manager, Node treated that as fatal.
    return settleTerminalRunFailure({
      error,
      cancelled: input.signal?.aborted === true,
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      thread: input.thread,
      userMessage: input.userMessage,
      run: input.run,
      liveEvents: input.liveEvents,
    });
  }
}

function failureCodeForStopReason(stopReason: StopReason): string {
  if (stopReason === "max_turns") return "AGENT_MAX_TURNS";
  if (stopReason === "deadline") return "AGENT_DEADLINE";
  return "AGENT_EXECUTION_FAILED";
}

async function relayEvent(
  event: CoreAgentEvent,
  sink: AgentEventSink | undefined,
  runId: string,
  messageId: string,
): Promise<void> {
  if (!sink) return;
  const at = new Date().toISOString();
  if (event.type === "started") return sink.emit({ type: "agent.started", runId, at });
  if (event.type === "text_delta") return sink.emit({ type: "message.delta", runId, messageId, delta: event.delta, at });
  if (event.type === "tool_started") {
    return sink.emit({
      type: "tool.started",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool_completed") {
    return sink.emit({
      type: "tool.completed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool_failed") {
    return sink.emit({
      type: "tool.failed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      error: event.error,
    });
  }
  // Map skips onto the existing tool.failed product event (no frontend change).
  if (event.type === "tool_skipped") {
    return sink.emit({
      type: "tool.failed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      error: event.reason,
    });
  }
  if (event.type === "completed") return sink.emit({ type: "message.completed", runId, messageId, content: event.text, at });
}

async function finalizeCompletedRun(input: {
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly content: string;
}): Promise<{ run: AgentRun; assistantMessage: AgentMessage | null }> {
  return input.persistence.withTransaction(async (tx) => {
    const content = input.content.trim();
    const assistantMessage = content
      ? await input.persistence.appendMessage({ threadId: input.threadId, ownerUserId: input.ownerUserId, role: "assistant", content }, tx)
      : null;
    const run = await input.persistence.updateRunStatus(
      { runId: input.runId, ownerUserId: input.ownerUserId, status: "completed" },
      tx,
    );
    return { run, assistantMessage };
  });
}

async function settleTerminalRunFailure(input: {
  readonly error: unknown;
  readonly cancelled: boolean;
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly liveEvents?: AgentEventSink;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}): Promise<AgentExecutionResult> {
  const runShort = input.run.id.slice(0, 8);
  const failureCode = input.failureCode ?? "AGENT_EXECUTION_FAILED";
  const failureMessage = input.failureMessage ?? "Agent execution failed";

  try {
    await updateRunAfterError(
      input.persistence,
      input.ownerUserId,
      input.run.id,
      input.cancelled,
      failureCode,
      failureMessage,
    );
  } catch (finalizeError) {
    console.error(
      `[agent] run=${runShort} terminal_finalize_failed reason=${summarizeError(finalizeError)}`,
    );
  }

  try {
    await input.liveEvents?.emit(
      input.cancelled
        ? { type: "agent.cancelled", runId: input.run.id, at: new Date().toISOString() }
        : {
            type: "agent.failed",
            runId: input.run.id,
            at: new Date().toISOString(),
            code: failureCode,
          },
    );
  } catch (emitError) {
    console.error(
      `[agent] run=${runShort} terminal_emit_failed reason=${summarizeError(emitError)}`,
    );
  }

  if (!input.cancelled) {
    console.error(`[agent] run=${runShort} failed reason=${summarizeError(input.error)}`);
  }

  return {
    thread: input.thread,
    userMessage: input.userMessage,
    run: await loadTerminalRun(
      input.persistence,
      input.ownerUserId,
      input.run,
      input.cancelled,
      failureCode,
      failureMessage,
    ),
    assistantMessage: null,
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 240);
  }
  return String(error).slice(0, 240);
}

async function updateRunAfterError(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  cancelled: boolean,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  await persistence.updateRunStatus({
    runId,
    ownerUserId,
    status: cancelled ? "cancelled" : "failed",
    ...(cancelled
      ? {}
      : { errorCode: failureCode, errorMessage: failureMessage }),
  });
}

async function loadTerminalRun(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  fallback: AgentRun,
  cancelled: boolean,
  failureCode: string,
  failureMessage: string,
): Promise<AgentRun> {
  const terminalStatus = cancelled ? "cancelled" : "failed";
  try {
    const run = await persistence.getRun({ runId: fallback.id, ownerUserId });
    if (run?.status === terminalStatus) return run;
  } catch {
    // fall through to in-memory terminal snapshot
  }
  return {
    ...fallback,
    status: terminalStatus,
    completedAt: new Date().toISOString(),
    errorCode: cancelled ? null : failureCode,
    errorMessage: cancelled ? null : failureMessage,
  };
}

function keepLeaseUntilFinished<T>(leases: AgentExecutionLeaseService, lease: AgentExecutionLease, result: Promise<T>): Promise<T> {
  const timer = setInterval(() => void leases.renew(lease).catch(() => undefined), AGENT_EXECUTION_LEASE_RENEW_MS);
  timer.unref?.();
  return result.finally(async () => {
    clearInterval(timer);
    await releaseLease(leases, lease);
  });
}

async function releaseLease(leases: AgentExecutionLeaseService, lease: AgentExecutionLease): Promise<void> {
  await leases.release(lease).catch(() => undefined);
}

export type AgentExecutionService = ReturnType<typeof createAgentExecutionService>;
