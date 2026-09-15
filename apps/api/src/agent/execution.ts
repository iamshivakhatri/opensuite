import {
  runAgent,
  type AgentEvent as CoreAgentEvent,
  type ModelMessage,
  type V2Model,
} from "@opensuite/agent-core-v2";

import type { DocxEngineBinding } from "@opensuite/engine-client";

import type { CredentialSource } from "../ai-preferences/types.js";
import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { DocumentService } from "../documents/service.js";
import type { ManagedTrialService } from "../managed-trial/service.js";
import type { ModelUsageService } from "../model-usage/service.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import {
  AgentPersistenceError,
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

export interface ResolvedV2ExecutionModel {
  readonly model: V2Model;
  readonly usageAttribution?: AgentModelUsageAttribution;
}

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
    "getOwnedDocument" | "readExactVersionBytes"
  >;
  readonly resolveModel: (userId: string) => Promise<ResolvedV2ExecutionModel>;
  readonly docxBinding?: DocxEngineBinding;
  readonly modelUsage?: ModelUsageService;
  readonly managedTrial?: ManagedTrialService;
  readonly lease?: AgentExecutionLeaseService;
}

/** Product shell: resolve and persist here; execute once in agent-core-v2. */
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

      console.info(`[agent] runtime=v2 run=${started.run.id.slice(0, 8)}`);
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
      const protectedResult = lease
        ? keepLeaseUntilFinished(deps.lease!, lease, result)
        : result;
      void protectedResult.catch(() => undefined);
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
): Promise<ResolvedV2ExecutionModel> {
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
  readonly model: ResolvedV2ExecutionModel;
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
  const messageId = `v2-${input.run.id}`;

  try {
    await input.deps.persistence.updateRunStatus({
      runId: input.run.id,
      ownerUserId: input.ownerUserId,
      status: "running",
    });
    console.info(
      `[agent-v2] model_start run=${input.run.id.slice(0, 8)} provider=openrouter model=${input.model.usageAttribution?.model ?? "unknown"}`,
    );
    if (
      input.model.usageAttribution?.provider === "openrouter" &&
      input.model.usageAttribution.credentialSource === "managed"
    ) {
      await input.deps.managedTrial?.beforeManagedCall(input.ownerUserId);
    }

    const tools = await createPrimaryDocxTools({
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      documentId: input.primaryDocumentId,
      versionId: input.run.baseDocumentVersionId,
    });

    // The one API → agent-core-v2 execution call.
    const result = await runAgent({
      model: input.model.model,
      messages,
      ...(tools ? { tools } : {}),
      signal: input.signal,
      onEvent: (event) => relayEvent(event, input.liveEvents, input.run.id, messageId),
    });
    console.info(
      `[agent-v2] model_done run=${input.run.id.slice(0, 8)} inputTokens=${result.inputTokens ?? "?"} outputTokens=${result.outputTokens ?? "?"} finishReason=${result.finishReason}`,
    );

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
    const cancelled = input.signal?.aborted === true;
    await updateRunAfterError(input.deps.persistence, input.ownerUserId, input.run.id, cancelled);
    await input.liveEvents?.emit(
      cancelled
        ? { type: "agent.cancelled", runId: input.run.id, at: new Date().toISOString() }
        : { type: "agent.failed", runId: input.run.id, at: new Date().toISOString(), code: "AGENT_EXECUTION_FAILED" },
    );
    if (cancelled) {
      return {
        thread: input.thread,
        userMessage: input.userMessage,
        run: await requireRun(input.deps.persistence, input.ownerUserId, input.run.id),
        assistantMessage: null,
      };
    }
    throw new AgentExecutionError("AGENT_EXECUTION_FAILED", "Agent execution failed");
  }
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

async function updateRunAfterError(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  cancelled: boolean,
): Promise<void> {
  try {
    await persistence.updateRunStatus({
      runId,
      ownerUserId,
      status: cancelled ? "cancelled" : "failed",
      ...(cancelled ? {} : { errorCode: "AGENT_EXECUTION_FAILED", errorMessage: "Agent execution failed" }),
    });
  } catch (error) {
    if (!(error instanceof AgentPersistenceError)) throw error;
  }
}

async function requireRun(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
): Promise<AgentRun> {
  const run = await persistence.getRun({ runId, ownerUserId });
  if (!run) throw new AgentExecutionError("AGENT_PERSISTENCE_FAILED", "Agent run was not found");
  return run;
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
