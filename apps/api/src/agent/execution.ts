import {
  createFinishTool,
  getRunMetricsFromError,
  isSuccessfulStop,
  runAgent,
  runModel,
  type AgentEvent as CoreAgentEvent,
  type AgentRunMetrics,
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
import {
  productionModelPricingRegistry,
} from "../model-usage/pricing.js";
import type { ModelUsageService } from "../model-usage/service.js";
import {
  composeAgentRunReport,
  logAgentRunReport,
  type DocumentTransition,
  type DocumentVersionAdvance,
} from "./agent-run-report.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import {
  formatRetrievedDocumentContext,
  formatTableRowDetail,
  retrieveRelevantDocumentContext,
  selectTableRowDetail,
  SlimDocumentStructureCache,
} from "./document-retrieval.js";
import {
  estimateTokens,
  projectHistoricalMessages,
  safeInputTokenBudget,
  truncateToTokenBudget,
} from "./context-projection.js";
import { compactThreadContext, logContextCompaction } from "./context-compaction.js";
import { buildAgentOperatingInstruction } from "./operating-instruction.js";
import {
  type AgentMessage,
  type AgentPersistenceService,
  type AgentRun,
  type AgentThread,
  type AgentThreadContextCheckpoint,
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
  | {
      readonly type: "document.created";
      readonly runId: string;
      readonly at: string;
      readonly documentId: string;
      readonly versionId: string;
      readonly versionNumber: number;
      readonly name: string;
      readonly kind: "created" | "duplicated";
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
  readonly contextLength?: number;
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
    | "getOwnedDocument"
    | "readExactVersionBytes"
    | "appendDocumentVersion"
    | "createBlankDocxDocument"
    | "createOfficeDocumentFromBytes"
  >;
  readonly resolveModel: (userId: string) => Promise<ResolvedV3ExecutionModel>;
  readonly docxBinding?: DocxEngineBinding;
  readonly modelUsage?: ModelUsageService;
  readonly managedTrial?: ManagedTrialService;
  readonly lease?: AgentExecutionLeaseService;
  /** Test seam — production uses agent-core-v3 `runAgent`. */
  readonly runAgent?: typeof runAgent;
  /** Test seam — production uses agent-core-v3 `runModel` for compaction. */
  readonly runModel?: typeof runModel;
}

/** Product shell: resolve and persist here; execute once in agent-core-v3. */
export function createAgentExecutionService(deps: AgentExecutionServiceDeps) {
  const structureCache = new SlimDocumentStructureCache();
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
        primaryDocumentFormat: primaryDocument?.format ?? null,
        structureCache,
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
): Promise<{ documentId: string; versionId: string; format: string } | null> {
  const documentId = documentIds?.[0] ?? thread.documentId;
  if (!documentId) return null;
  try {
    const document = await documents.getOwnedDocument({ documentId, ownerUserId: userId });
    if (document.workspaceId !== thread.workspaceId) {
      throw new AgentExecutionError("DOCUMENT_NOT_FOUND", "Document is not in this workspace");
    }
    return { documentId, versionId: document.latestVersion.id, format: document.format };
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
  readonly primaryDocumentFormat: string | null;
  readonly structureCache: SlimDocumentStructureCache;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
}): Promise<AgentExecutionResult> {
  const checkpoint = await input.deps.persistence.getLatestThreadContextCheckpoint({
    threadId: input.thread.id,
    ownerUserId: input.ownerUserId,
  });
  const priorMessages = checkpoint
    ? await input.deps.persistence.listMessagesAfterThreadContextCheckpoint({
        threadId: input.thread.id,
        ownerUserId: input.ownerUserId,
        checkpoint,
      })
    : await input.deps.persistence.listMessagesForThread({
        threadId: input.thread.id,
        ownerUserId: input.ownerUserId,
      });
  const messageId = `v3-${input.run.id}`;
  const retrieval = await loadRetrievedContext({
    cache: input.structureCache,
    binding: input.deps.docxBinding,
    documents: input.deps.documents,
    ownerUserId: input.ownerUserId,
    documentId: input.primaryDocumentId,
    versionId: input.run.baseDocumentVersionId,
    format: input.primaryDocumentFormat,
    instruction: input.instruction,
  });

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

    const versionAdvances: DocumentVersionAdvance[] = [];
    const initialDocumentId = input.primaryDocumentId;
    const boundTools = await createPrimaryDocxTools({
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      workspaceId: input.thread.workspaceId,
      documentId: input.primaryDocumentId,
      versionId: input.run.baseDocumentVersionId,
      onVersionAdvanced: async (advanced) => {
        versionAdvances.push({
          fromVersionId: advanced.fromVersionId,
          toVersionId: advanced.versionId,
        });
        await input.liveEvents?.emit({
          type: "document.version.advanced",
          runId: input.run.id,
          at: new Date().toISOString(),
          documentId: advanced.documentId,
          versionId: advanced.versionId,
          versionNumber: advanced.versionNumber,
        });
      },
      onDocumentCreated: async (created) => {
        await input.liveEvents?.emit({
          type: "document.created",
          runId: input.run.id,
          at: new Date().toISOString(),
          documentId: created.documentId,
          versionId: created.versionId,
          versionNumber: created.versionNumber,
          name: created.name,
          kind: created.kind,
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
    const system = buildAgentOperatingInstruction(Object.keys(tools));
    const historicalMessages = priorMessages
      .filter((message) => message.id !== input.userMessage.id)
      .map((message) => ({ role: message.role, content: message.content }));
    const fixedTokens =
      estimateTokens(system) +
      estimateTokens(toolContext(tools)) +
      estimateTokens(input.instruction) +
      estimateTokens(retrieval?.message ?? "");
    const inputBudget =
      input.model.contextLength !== undefined
        ? safeInputTokenBudget(input.model.contextLength)
        : undefined;
    const checkpointContent = checkpoint
      ? checkpointMessageContent(checkpoint)
      : "";
    const checkpointBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - fixedTokens);
    const projectedCheckpoint = checkpoint
      ? truncateToTokenBudget(checkpointContent, checkpointBudget ?? estimateTokens(checkpointContent))
      : "";
    const historicalBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - fixedTokens - estimateTokens(projectedCheckpoint));
    const historical = projectHistoricalMessages(historicalMessages, {
      ...(historicalBudget !== undefined ? { maxTokens: historicalBudget } : {}),
    });
    const { messages: projectedHistoricalMessages, ...historicalContext } = historical;
    const context = {
      ...historicalContext,
      checkpointUsed: checkpoint !== null,
      ...(checkpoint
        ? { checkpointThroughMessageId: checkpoint.throughMessageId }
        : {}),
      historicalMessagesAfterCheckpoint: historicalMessages.length,
      ...(input.model.contextLength !== undefined
        ? { modelContextLength: input.model.contextLength }
        : {}),
      estimatedInputTokens:
        fixedTokens + estimateTokens(projectedCheckpoint) + historical.estimatedHistoricalTokens,
      approximateTokenBudgetApplied: inputBudget !== undefined,
    };
    const messages: ModelMessage[] = [
      ...(projectedCheckpoint ? [{ role: "user" as const, content: projectedCheckpoint }] : []),
      ...projectedHistoricalMessages,
      { role: "user", content: input.instruction },
    ];

    // The one API → agent-core-v3 execution call.
    const executeAgent = input.deps.runAgent ?? runAgent;
    let result;
    try {
      result = await executeAgent({
        model: input.model.model,
        system,
        messages,
        ...(retrieval?.message
          ? { projectMessages: firstTurnContextProjection(retrieval.message) }
          : {}),
        tools,
        signal: input.signal,
        runId: runShort,
        onEvent: (event) => relayEvent(event, input.liveEvents, input.run.id, messageId),
      });
    } catch (error) {
      emitRunReport({
        runId: input.run.id,
        instruction: input.instruction,
        model: input.model,
        metrics: getRunMetricsFromError(error),
        cancelled: input.signal?.aborted === true,
        thrown: true,
        initialDocumentId,
        initialVersionId: input.run.baseDocumentVersionId,
        finalDocumentId: boundTools?.getActiveDocumentId() ?? initialDocumentId,
        finalVersionId: boundTools?.getActiveVersionId() ?? input.run.baseDocumentVersionId,
        versionAdvances,
        documentTransitions: boundTools?.getTransitions() ?? [],
        retrieval: retrieval?.observation,
        context,
      });
      throw error;
    }

    emitRunReport({
      runId: input.run.id,
      instruction: input.instruction,
      model: input.model,
      metrics: result.metrics,
      stopReason: result.stopReason,
      cancelled: false,
      thrown: false,
      initialDocumentId,
      initialVersionId: input.run.baseDocumentVersionId,
      finalDocumentId: boundTools?.getActiveDocumentId() ?? initialDocumentId,
      finalVersionId: boundTools?.getActiveVersionId() ?? input.run.baseDocumentVersionId,
      versionAdvances,
      documentTransitions: boundTools?.getTransitions() ?? [],
      retrieval: retrieval?.observation,
      context,
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
    void compactThreadContext({
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      threadId: input.thread.id,
      model: input.model.model,
      contextLength: input.model.contextLength,
      usageAttribution: input.model.usageAttribution,
      modelUsage: input.deps.modelUsage,
      managedTrial: input.deps.managedTrial,
      runModel: input.deps.runModel,
    })
      .then(logContextCompaction)
      .catch(() => console.warn("[context-compaction] maintenance failed"));
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

function toolContext(tools: AgentToolSet): string {
  return Object.entries(tools)
    .map(([name, tool]) => `${name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
}

async function loadRetrievedContext(input: {
  readonly cache: SlimDocumentStructureCache;
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: AgentExecutionServiceDeps["documents"];
  readonly ownerUserId: string;
  readonly documentId: string | null;
  readonly versionId: string | null;
  readonly format: string | null;
  readonly instruction: string;
}): Promise<{
  readonly message?: string;
  readonly observation: { readonly cache: "hit" | "miss"; readonly blockCount: number; readonly reason?: string; readonly detail?: { readonly kind: "table_rows"; readonly itemCount: number } };
} | undefined> {
  if (!input.binding || !input.documentId || !input.versionId || input.format !== "docx") return undefined;
  try {
    const bytes = await input.documents.readExactVersionBytes({
      documentId: input.documentId,
      versionId: input.versionId,
      ownerUserId: input.ownerUserId,
    });
    const loaded = await input.cache.get({
      versionId: input.versionId,
      bytes: new Uint8Array(bytes),
      binding: input.binding,
    });
    const context = retrieveRelevantDocumentContext(input.instruction, loaded.structure);
    const detailRequest = context && selectTableRowDetail(input.instruction, context);
    const tableRows = detailRequest
      ? await input.binding.inspectDocx(new Uint8Array(bytes), { focus: { kind: "table_rows", tableHandle: detailRequest.tableHandle, rowOffset: detailRequest.rowOffset, rowLimit: detailRequest.rowLimit } })
      : undefined;
    const detail = tableRows?.ok ? tableRows.tableRows : undefined;
    const observation = context
      ? { cache: loaded.cache, blockCount: context.blocks.length, reason: context.reason, ...(detail ? { detail: { kind: "table_rows" as const, itemCount: detail.rows.length } } : {}) }
      : { cache: loaded.cache, blockCount: 0 };
    console.info(`[agent-v3] structure_cache=${loaded.cache} retrieved_blocks=${observation.blockCount}`);
    return context
      ? { message: [formatRetrievedDocumentContext(context), ...(detail ? [formatTableRowDetail(detail)] : [])].join("\n"), observation }
      : { observation };
  } catch (error) {
    console.warn(`[agent-v3] structure_retrieval_skipped reason=${summarizeError(error)}`);
    return undefined;
  }
}

export function firstTurnContextProjection(context: string): (messages: readonly ModelMessage[]) => readonly ModelMessage[] {
  let firstTurn = true;
  return (messages) => {
    if (!firstTurn) return messages;
    firstTurn = false;
    return [...messages, { role: "user", content: context }];
  };
}

/** AI SDK has no application-context role; label this API-owned user message. */
function checkpointMessageContent(checkpoint: AgentThreadContextCheckpoint): string {
  return `Historical conversation checkpoint through ${checkpoint.throughMessageId}:\n${checkpoint.content}`;
}

function failureCodeForStopReason(stopReason: StopReason): string {
  if (stopReason === "max_turns") return "AGENT_MAX_TURNS";
  if (stopReason === "deadline") return "AGENT_DEADLINE";
  return "AGENT_EXECUTION_FAILED";
}

function emitRunReport(input: {
  readonly runId: string;
  readonly instruction: string;
  readonly model: ResolvedV3ExecutionModel;
  readonly metrics: AgentRunMetrics | undefined;
  readonly stopReason?: StopReason;
  readonly cancelled: boolean;
  readonly thrown: boolean;
  readonly initialDocumentId?: string | null;
  readonly finalDocumentId?: string | null;
  readonly initialVersionId: string | null;
  readonly finalVersionId?: string | null;
  readonly versionAdvances: readonly DocumentVersionAdvance[];
  readonly documentTransitions?: readonly DocumentTransition[];
  readonly retrieval?: { readonly cache: "hit" | "miss"; readonly blockCount: number; readonly reason?: string; readonly detail?: { readonly kind: "table_rows"; readonly itemCount: number } };
  readonly context: {
    readonly checkpointUsed: boolean;
    readonly checkpointThroughMessageId?: string;
    readonly historicalMessagesLoaded: number;
    readonly historicalMessagesAfterCheckpoint: number;
    readonly historicalMessagesProjected: number;
    readonly historicalCharactersLoaded: number;
    readonly historicalCharactersProjected: number;
    readonly estimatedHistoricalTokens: number;
    readonly historyWasTrimmed: boolean;
    readonly modelContextLength?: number;
    readonly estimatedInputTokens: number;
    readonly approximateTokenBudgetApplied: boolean;
    readonly historyTrimmedByTokenBudget: boolean;
  };
}): void {
  if (!input.metrics) return;
  try {
    const attribution = input.model.usageAttribution;
    const pricing =
      attribution !== undefined
        ? productionModelPricingRegistry.lookup(
            attribution.provider,
            attribution.model,
          )
        : null;
    const report = composeAgentRunReport({
      runId: input.runId,
      instruction: input.instruction,
      ...(attribution !== undefined
        ? { provider: attribution.provider, model: attribution.model }
        : {}),
      metrics: input.metrics,
      ...(input.stopReason !== undefined
        ? { stopReason: input.stopReason }
        : {}),
      cancelled: input.cancelled,
      thrown: input.thrown,
      initialDocumentId: input.initialDocumentId,
      finalDocumentId: input.finalDocumentId,
      initialVersionId: input.initialVersionId,
      finalVersionId: input.finalVersionId,
      versionAdvances: input.versionAdvances,
      documentTransitions: input.documentTransitions ?? [],
      ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}),
      context: input.context,
      pricing,
      ...(attribution !== undefined
        ? { pricingProvider: attribution.provider }
        : {}),
    });
    logAgentRunReport(report);
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_failed reason=${summarizeError(error)}`,
    );
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
