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
  type AgentRunReportRetrieval,
  type DocumentTransition,
  type DocumentVersionAdvance,
} from "./agent-run-report.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import {
  retrieveWorkspaceContext,
  SlimDocumentStructureCache,
  formatDocumentMap,
} from "./document-retrieval.js";
import {
  estimateTokens,
  availableEvidenceTokenBudget,
  computeInputBudget,
  MAX_HISTORY_MESSAGES,
  projectHistoricalMessages,
  truncateToTokenBudget,
} from "./context-projection.js";
import { compactThreadContext, logContextCompaction } from "./context-compaction.js";
import {
  accumulateInRunObservationStats,
  createInRunObservationStats,
  projectInRunObservations,
} from "./in-run-observation-projection.js";
import { buildAgentOperatingInstruction } from "./operating-instruction.js";
import {
  type AgentMessage,
  type AgentPersistenceService,
  type AgentRun,
  type AgentStepKind,
  type AgentStepStatus,
  type AgentThread,
  type AgentThreadContextCheckpoint,
} from "./persistence.js";
import {
  AGENT_EXECUTION_LEASE_RENEW_MS,
  type AgentExecutionLease,
  type AgentExecutionLeaseService,
} from "./execution-lease.js";

const MAX_MODEL_TURNS = 20;

type TranscriptEntry = {
  readonly kind: AgentStepKind;
  readonly status: AgentStepStatus;
  readonly name: string;
  readonly summary: string;
};

function createTranscriptCollector() {
  const entries: TranscriptEntry[] = [];
  let narration = "";
  const flushNarration = () => {
    const summary = narration.trim();
    narration = "";
    if (summary) entries.push({ kind: "narration", status: "completed", name: "Assistant narration", summary });
  };
  return {
    text(delta: string) {
      narration += delta;
    },
    toolStarted() {
      flushNarration();
    },
    toolFinished(toolName: string, status: AgentStepStatus, skipped = false) {
      entries.push({
        kind: toolName === "document.inspect" ? "inspect" : "tool",
        status,
        name: toolName,
        summary: skipped ? "Skipped" : status === "completed" ? "Completed" : "Failed",
      });
    },
    finish(finalText?: string) {
      const remaining = narration.trim();
      narration = "";
      if (
        remaining &&
        remaining.replace(/\s+/g, " ") !== (finalText ?? "").trim().replace(/\s+/g, " ")
      ) {
        entries.push({ kind: "narration", status: "completed", name: "Assistant narration", summary: remaining });
      }
    },
    entries() {
      return entries;
    },
  };
}

async function persistTranscript(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  entries: readonly TranscriptEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await persistence.appendSteps({
      runId,
      ownerUserId,
      steps: entries.map((entry, sequence) => ({ ...entry, sequence })),
    });
  } catch (error) {
    console.error(`[agent] run=${runId.slice(0, 8)} transcript_persist_failed reason=${summarizeError(error)}`);
  }
}

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
  readonly maxOutputTokens?: number;
}

/** @deprecated Use ResolvedV3ExecutionModel — alias during V3 cutover. */
export type ResolvedV2ExecutionModel = ResolvedV3ExecutionModel;

export type AgentExecutionErrorCode =
  | "THREAD_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "AI_CONFIGURATION_INVALID"
  | "AGENT_EXECUTION_BUSY"
  | "INVALID_CONTINUATION"
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
  readonly activeDocumentId?: string;
  readonly documentIds?: readonly string[];
  readonly continueFromRunId?: string;
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
    | "listInWorkspace"
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

    const continuation = input.continueFromRunId
      ? await resolveContinuation(deps.persistence, input, thread)
      : null;

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
        input.activeDocumentId,
      );
      const persistedWorkingDocumentIds = await deps.persistence.listWorkingDocumentIds({
        threadId: thread.id,
        ownerUserId: input.userId,
      });
      const workingDocumentIds = [...new Set([
        ...persistedWorkingDocumentIds,
        ...(primaryDocument ? [primaryDocument.documentId] : []),
        ...(input.documentIds ?? []),
      ])];
      const started = await deps.persistence.withTransaction(async (tx) => {
        await deps.persistence.addWorkingDocuments({
          threadId: thread.id,
          ownerUserId: input.userId,
          documentIds: workingDocumentIds,
        }, tx);
        const userMessage = await deps.persistence.appendMessage(
          {
            threadId: thread.id,
            ownerUserId: input.userId,
            role: "user",
            content: input.instruction,
            documentIds: input.documentIds,
          },
          tx,
        );
        const run = await deps.persistence.createRun(
          {
            threadId: thread.id,
            ownerUserId: input.userId,
            createdByUserId: input.userId,
            triggeringMessageId: continuation?.triggeringMessageId ?? userMessage.id,
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
        submittedDocumentIds: input.documentIds ?? [],
        workingDocumentIds,
        ...(continuation ? { continuationContext: continuation.context } : {}),
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

async function resolveContinuation(
  persistence: AgentPersistenceService,
  input: AgentExecutionInput,
  thread: AgentThread,
): Promise<{ readonly triggeringMessageId: string; readonly context: string }> {
  const prior = await persistence.getRun({
    runId: input.continueFromRunId!,
    ownerUserId: input.userId,
  });
  if (
    !prior ||
    prior.threadId !== thread.id ||
    prior.status !== "failed" ||
    prior.errorCode !== "AGENT_MAX_TURNS" ||
    !prior.triggeringMessageId
  ) {
    throw new AgentExecutionError("INVALID_CONTINUATION", "This run cannot be continued.");
  }
  const original = await persistence.getMessageForThread({
    messageId: prior.triggeringMessageId,
    threadId: thread.id,
    ownerUserId: input.userId,
  });
  if (!original || original.role !== "user") {
    throw new AgentExecutionError("INVALID_CONTINUATION", "This run cannot be continued.");
  }
  return {
    triggeringMessageId: original.id,
    context: `Application continuation context:\nThis run continues a previous run that reached its model-turn limit.\n\nOriginal task:\n${original.content}\n\nVerified changes from the previous run were preserved. Continue from the CURRENT bound document state. Do not assume old handles or locations are valid. Do not repeat completed work unnecessarily. Inspect current state only as needed and complete the remaining task.`,
  };
}

async function resolvePrimaryDocument(
  documents: Pick<DocumentService, "getOwnedDocument">,
  thread: AgentThread,
  userId: string,
  activeDocumentId: string | undefined,
): Promise<{ documentId: string; versionId: string; format: string } | null> {
  const documentId = activeDocumentId ?? thread.documentId;
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
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
  readonly continuationContext?: string;
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
}): Promise<AgentExecutionResult> {
  const transcript = createTranscriptCollector();
  try {
    const checkpoint = await input.deps.persistence.getLatestThreadContextCheckpoint({
      threadId: input.thread.id,
      ownerUserId: input.ownerUserId,
    });
    const priorMessages = await input.deps.persistence.listRecentMessagesForContext({
      threadId: input.thread.id,
      ownerUserId: input.ownerUserId,
      checkpoint,
      excludeMessageId: input.userMessage.id,
      limit: MAX_HISTORY_MESSAGES,
    });
    const messageId = `v3-${input.run.id}`;
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
      description: "After your concise final response to the user, call this to end the run.",
    });
    const tools: AgentToolSet = {
      ...(boundTools?.tools ?? {}),
      [finish.name]: finish.tool,
    };
    const system = buildAgentOperatingInstruction(Object.keys(tools));
    const historicalMessages = priorMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const requiredTokens =
      estimateTokens(system) +
      estimateTokens(toolContext(tools)) +
      estimateTokens(input.instruction) +
      estimateTokens(input.continuationContext ?? "");
    const budget =
      input.model.contextLength !== undefined
        ? computeInputBudget({
            contextLength: input.model.contextLength,
            maxOutputTokens: input.model.maxOutputTokens,
          })
        : undefined;
    if (budget?.usedOutputReserveFallback) {
      console.info(
        `[agent] output_reserve_fallback run=${runShort} tokens=${budget.outputReserve} model=${input.model.usageAttribution?.model ?? "unknown"}`,
      );
    }
    const inputBudget = budget?.safeInputBudget;
    const checkpointContent = checkpoint
      ? checkpointMessageContent(checkpoint)
      : "";
    const checkpointBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - requiredTokens);
    const projectedCheckpoint = checkpoint
      ? truncateToTokenBudget(checkpointContent, checkpointBudget ?? estimateTokens(checkpointContent))
      : "";
    const historicalBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - requiredTokens - estimateTokens(projectedCheckpoint));
    const historical = projectHistoricalMessages(historicalMessages, {
      ...(historicalBudget !== undefined ? { maxTokens: historicalBudget } : {}),
    });
    const planningAvailableEvidenceTokens = availableEvidenceTokenBudget(
      input.model.contextLength,
      requiredTokens + estimateTokens(projectedCheckpoint) + historical.estimatedHistoricalTokens,
      input.model.maxOutputTokens,
    );
    const retrieval = await loadRetrievedContext({
      cache: input.structureCache,
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      instruction: input.instruction,
      workspaceId: input.thread.workspaceId,
      primaryDocumentId: input.primaryDocumentId,
      primaryVersionId: input.run.baseDocumentVersionId,
      submittedDocumentIds: input.submittedDocumentIds,
      workingDocumentIds: input.workingDocumentIds,
      availableEvidenceTokens: planningAvailableEvidenceTokens,
    });
    const evidenceTokens = estimateTokens(retrieval?.message ?? "");
    const finalCheckpointBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - requiredTokens - evidenceTokens);
    const finalProjectedCheckpoint = checkpoint
      ? truncateToTokenBudget(checkpointContent, finalCheckpointBudget ?? estimateTokens(checkpointContent))
      : "";
    const finalHistoricalBudget = inputBudget === undefined
      ? undefined
      : Math.max(0, inputBudget - requiredTokens - evidenceTokens - estimateTokens(finalProjectedCheckpoint));
    const finalHistorical = projectHistoricalMessages(historicalMessages, {
      ...(finalHistoricalBudget !== undefined ? { maxTokens: finalHistoricalBudget } : {}),
    });
    const { messages: finalProjectedHistoricalMessages, ...finalHistoricalContext } = finalHistorical;
    const availableEvidenceTokens = availableEvidenceTokenBudget(
      input.model.contextLength,
      requiredTokens + estimateTokens(finalProjectedCheckpoint) + finalHistorical.estimatedHistoricalTokens,
      input.model.maxOutputTokens,
    );
    const context = {
      ...finalHistoricalContext,
      checkpointUsed: checkpoint !== null,
      historyQueryMode: checkpoint ? "post_checkpoint" as const : "recent" as const,
      ...(checkpoint
        ? { checkpointThroughMessageId: checkpoint.throughMessageId }
        : {}),
      historicalMessagesAfterCheckpoint: historicalMessages.length,
      ...(budget !== undefined
        ? {
            modelContextLength: budget.contextLength,
            outputReserveTokens: budget.outputReserve,
            continuationReserveTokens: budget.continuationReserve,
            safetyMarginTokens: budget.safetyMargin,
            safeInputBudgetTokens: budget.safeInputBudget,
          }
        : {}),
      estimatedInputTokens: requiredTokens + evidenceTokens + estimateTokens(finalProjectedCheckpoint) + finalHistorical.estimatedHistoricalTokens,
      approximateTokenBudgetApplied: inputBudget !== undefined,
    };
    const reportRetrieval = retrieval
      ? {
          ...retrieval.observation,
          ...(availableEvidenceTokens !== undefined
            ? { availableEvidenceTokens }
            : {}),
        }
      : undefined;
    const messages: ModelMessage[] = [
      ...(finalProjectedCheckpoint ? [{ role: "user" as const, content: finalProjectedCheckpoint }] : []),
      ...finalProjectedHistoricalMessages,
      ...(input.continuationContext
        ? [{ role: "user" as const, content: input.continuationContext }]
        : []),
      { role: "user", content: input.instruction },
    ];

    const inRunStats = createInRunObservationStats();
    const projectMessages = composeProjectMessages({
      retrievalMessage: retrieval?.message,
      tools,
      stats: inRunStats,
    });

    // The one API → agent-core-v3 execution call.
    const executeAgent = input.deps.runAgent ?? runAgent;
    let result;
    try {
      result = await executeAgent({
        model: input.model.model,
        system,
        messages,
        projectMessages,
        tools,
        signal: input.signal,
        runId: runShort,
        maxTurns: MAX_MODEL_TURNS,
        onEvent: (event) => relayEvent(event, input.liveEvents, input.run.id, messageId, transcript),
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
        retrieval: reportRetrieval,
        context: {
          ...context,
          inRunObservationsCompacted: inRunStats.observationsCompacted,
          estimatedInRunTokensBefore: inRunStats.estimatedInRunTokensBefore,
          estimatedInRunTokensAfter: inRunStats.estimatedInRunTokensAfter,
          maxProjectedInputTokens: inRunStats.maxProjectedInputTokens,
        },
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
      retrieval: reportRetrieval,
      context: {
        ...context,
        inRunObservationsCompacted: inRunStats.observationsCompacted,
        estimatedInRunTokensBefore: inRunStats.estimatedInRunTokensBefore,
        estimatedInRunTokensAfter: inRunStats.estimatedInRunTokensAfter,
        maxProjectedInputTokens: inRunStats.maxProjectedInputTokens,
      },
    });

    if (!isSuccessfulStop(result.stopReason)) {
      transcript.finish();
      const boundedStop = result.stopReason === "max_turns" || result.stopReason === "deadline";
      return settleTerminalRunFailure({
        ...(boundedStop ? { expectedStop: result.stopReason } : {}),
        cancelled: input.signal?.aborted === true,
        persistence: input.deps.persistence,
        ownerUserId: input.ownerUserId,
        thread: input.thread,
        userMessage: input.userMessage,
        run: input.run,
        liveEvents: input.liveEvents,
        failureCode: failureCodeForStopReason(result.stopReason),
        failureMessage: boundedStopMessage(result.stopReason, versionAdvances.length > 0),
        transcript: transcript.entries(),
      });
    }

    if (input.deps.modelUsage && input.model.usageAttribution) {
      const usage = await input.deps.modelUsage.recordFromProviderResponse({
        attribution: { ...input.model.usageAttribution, userId: input.ownerUserId, agentRunId: input.run.id },
        usage: {
          inputTokens: result.inputTokens,
          cachedInputTokens: result.cachedInputTokens,
          outputTokens: result.outputTokens,
          ...(result.reasoningTokens !== undefined
            ? { reasoningTokens: result.reasoningTokens }
            : {}),
        },
        ...(result.providerReportedCostUsd !== undefined
          ? { providerReportedCostUsd: result.providerReportedCostUsd }
          : {}),
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
    transcript.finish(result.text);
    await persistTranscript(input.deps.persistence, input.ownerUserId, input.run.id, transcript.entries());
    await input.liveEvents?.emit({ type: "agent.completed", runId: input.run.id, at: new Date().toISOString() });
    void compactThreadContext({
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      threadId: input.thread.id,
      model: input.model.model,
      contextLength: input.model.contextLength,
      maxOutputTokens: input.model.maxOutputTokens,
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
    // Includes pre-model setup (checkpoint/history load). Re-throwing here used
    // to reject the background promise and leave the run non-terminal forever.
    transcript.finish();
    return settleTerminalRunFailure({
      error,
      cancelled: input.signal?.aborted === true,
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      thread: input.thread,
      userMessage: input.userMessage,
      run: input.run,
      liveEvents: input.liveEvents,
      transcript: transcript.entries(),
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
  readonly instruction: string;
  readonly workspaceId: string;
  readonly primaryDocumentId: string | null;
  readonly primaryVersionId: string | null;
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
  readonly availableEvidenceTokens?: number;
}): Promise<{
  readonly message?: string;
  readonly observation: {
    readonly workspaceArtifactCount: number;
    readonly workingSetArtifactCount: number;
    readonly documentMapCharacters: number;
    readonly contextStrategy: "direct" | "hierarchical" | "retrieval";
    readonly plannerEvidenceBudgetTokens?: number;
    readonly fullDocumentEstimatedTokens?: number;
    readonly candidateCount: number;
    readonly evidenceCount: number;
    readonly durationMs: number;
    readonly contextCharacters: number;
    readonly candidates: readonly {
      readonly documentId: string;
      readonly versionId: string;
      readonly name: string;
      readonly format: string;
      readonly reason: string;
    }[];
  };
} | undefined> {
  if (!input.binding) return undefined;
  const startedAt = Date.now();
  try {
    const documents = await input.documents.listInWorkspace(input.workspaceId, input.ownerUserId);
    const retrieved = await retrieveWorkspaceContext({
      artifacts: documents.map((document) => ({
        documentId: document.id,
        versionId: document.id === input.primaryDocumentId && input.primaryVersionId
          ? input.primaryVersionId
          : document.latestVersion.id,
        name: document.name,
        format: document.format,
      })),
      instruction: input.instruction,
      primaryDocumentId: input.primaryDocumentId,
      taggedDocumentIds: input.submittedDocumentIds,
      workingSetDocumentIds: input.workingDocumentIds,
      binding: input.binding,
      cache: input.cache,
      availableEvidenceTokens: input.availableEvidenceTokens,
      readBytes: async (artifact) => new Uint8Array(await input.documents.readExactVersionBytes({
        documentId: artifact.documentId,
        versionId: artifact.versionId,
        ownerUserId: input.ownerUserId,
      })),
    });
    const message = retrieved.message;
    return {
      ...(message ? { message } : {}),
      observation: {
        workspaceArtifactCount: documents.length,
        workingSetArtifactCount: retrieved.workingSet.length,
        documentMapCharacters: retrieved.documentMaps.reduce((total, map) => total + formatDocumentMap(map).length, 0),
        contextStrategy: retrieved.contextStrategy,
        ...(retrieved.plannerEvidenceBudgetTokens !== undefined ? { plannerEvidenceBudgetTokens: retrieved.plannerEvidenceBudgetTokens } : {}),
        ...(retrieved.fullDocumentEstimatedTokens !== undefined ? { fullDocumentEstimatedTokens: retrieved.fullDocumentEstimatedTokens } : {}),
        candidateCount: retrieved.candidates.length,
        evidenceCount: retrieved.evidence.length,
        durationMs: Date.now() - startedAt,
        contextCharacters: message?.length ?? 0,
        candidates: retrieved.candidates,
      },
    };
  } catch (error) {
    console.warn(`[agent-v3] workspace_retrieval_skipped reason=${summarizeError(error)}`);
    return undefined;
  }
}

export function firstTurnContextProjection(context: string): (messages: readonly ModelMessage[]) => readonly ModelMessage[] {
  let firstTurn = true;
  return (messages) => {
    if (!firstTurn) return messages;
    firstTurn = false;
    const instruction = messages.at(-1);
    if (!instruction || instruction.role !== "user") {
      return [...messages, { role: "user", content: context }];
    }
    return [...messages.slice(0, -1), { role: "user", content: context }, instruction];
  };
}

/**
 * Compose Phase 6 first-turn retrieval with C7 in-run observation projection.
 * Retrieval injects once; C7 runs every turn on the model-facing view only.
 */
export function composeProjectMessages(input: {
  readonly retrievalMessage?: string;
  readonly tools: AgentToolSet;
  readonly stats: ReturnType<typeof createInRunObservationStats>;
}): (messages: readonly ModelMessage[]) => readonly ModelMessage[] {
  const firstTurn = input.retrievalMessage
    ? firstTurnContextProjection(input.retrievalMessage)
    : (messages: readonly ModelMessage[]) => messages;
  const isMutateTool = (toolName: string) =>
    input.tools[toolName]?.kind === "mutate";

  return (messages) => {
    const afterFirstTurn = firstTurn(messages);
    const projected = projectInRunObservations(afterFirstTurn, { isMutateTool });
    accumulateInRunObservationStats(input.stats, projected);
    return projected.messages;
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

export function boundedStopMessage(
  stopReason: StopReason,
  hasVersionAdvance: boolean,
): string {
  const stopped = stopReason === "max_turns"
    ? "Stopped before completing the task."
    : "Stopped before the task could be completed.";
  return hasVersionAdvance ? `${stopped} Changes made so far were preserved.` : stopped;
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
  readonly retrieval?: AgentRunReportRetrieval;
  readonly context: {
    readonly checkpointUsed: boolean;
    readonly checkpointThroughMessageId?: string;
    readonly historyQueryMode: "recent" | "post_checkpoint";
    readonly historicalMessagesLoaded: number;
    readonly historicalMessagesAfterCheckpoint: number;
    readonly historicalMessagesProjected: number;
    readonly historicalCharactersLoaded: number;
    readonly historicalCharactersProjected: number;
    readonly estimatedHistoricalTokens: number;
    readonly historyWasTrimmed: boolean;
    readonly modelContextLength?: number;
    readonly outputReserveTokens?: number;
    readonly continuationReserveTokens?: number;
    readonly safetyMarginTokens?: number;
    readonly safeInputBudgetTokens?: number;
    readonly estimatedInputTokens: number;
    readonly approximateTokenBudgetApplied: boolean;
    readonly historyTrimmedByTokenBudget: boolean;
    readonly inRunObservationsCompacted?: number;
    readonly estimatedInRunTokensBefore?: number;
    readonly estimatedInRunTokensAfter?: number;
    readonly maxProjectedInputTokens?: number;
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
  transcript: ReturnType<typeof createTranscriptCollector>,
): Promise<void> {
  if (event.type === "text_delta") transcript.text(event.delta);
  if (event.type === "tool_started") transcript.toolStarted();
  if (event.type === "tool_completed") transcript.toolFinished(event.toolName, "completed");
  if (event.type === "tool_failed") transcript.toolFinished(event.toolName, "failed");
  if (event.type === "tool_skipped") transcript.toolFinished(event.toolName, "cancelled", true);
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
      {
        runId: input.runId,
        ownerUserId: input.ownerUserId,
        status: "completed",
        resultMessageId: assistantMessage?.id ?? null,
      },
      tx,
    );
    return { run, assistantMessage };
  });
}

async function settleTerminalRunFailure(input: {
  readonly error?: unknown;
  /** A normal runtime boundary, not an unexpected exception. */
  readonly expectedStop?: StopReason;
  readonly cancelled: boolean;
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly liveEvents?: AgentEventSink;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly transcript?: readonly TranscriptEntry[];
}): Promise<AgentExecutionResult> {
  const runShort = input.run.id.slice(0, 8);
  const failureCode = input.failureCode ?? "AGENT_EXECUTION_FAILED";
  const failureMessage = input.failureMessage ?? "Agent execution failed";

  // Idempotent: if already terminal (e.g. outer safety net after settle),
  // do not attempt another status transition or duplicate terminal SSE.
  let alreadyTerminal = false;
  try {
    const current = await input.persistence.getRun({
      runId: input.run.id,
      ownerUserId: input.ownerUserId,
    });
    if (
      current &&
      (current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled")
    ) {
      alreadyTerminal = true;
    }
  } catch {
    // fall through and attempt settle
  }

  if (!alreadyTerminal) {
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

    await persistTranscript(
      input.persistence,
      input.ownerUserId,
      input.run.id,
      input.transcript ?? [],
    );

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
  }

  if (!input.cancelled && input.expectedStop === undefined) {
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
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 4) {
    depth += 1;
    if (current instanceof Error) {
      const name = current.name || "Error";
      // Prefer the underlying DB/driver message over Drizzle's "Failed query: …"
      // wrapper (which dumps SQL). Never include the full query text.
      const message = sanitizeErrorMessage(current.message);
      const code =
        "code" in current &&
        (typeof (current as { code?: unknown }).code === "string" ||
          typeof (current as { code?: unknown }).code === "number")
          ? String((current as { code: string | number }).code)
          : undefined;
      parts.push(
        code ? `${name}: ${message} (code=${code})` : `${name}: ${message}`,
      );
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const code =
        typeof record.code === "string" || typeof record.code === "number"
          ? String(record.code)
          : undefined;
      const detail =
        typeof record.detail === "string"
          ? sanitizeErrorMessage(record.detail)
          : typeof record.message === "string"
            ? sanitizeErrorMessage(record.message)
            : undefined;
      if (code || detail) {
        parts.push([code ? `code=${code}` : null, detail].filter(Boolean).join(" "));
      }
      current = "cause" in record ? record.cause : undefined;
      continue;
    }
    parts.push(sanitizeErrorMessage(String(current)));
    break;
  }
  const summary = parts.join(" | ");
  return summary.slice(0, 400) || "unknown error";
}

/** Strip SQL bodies / connection strings from loggable error text. */
function sanitizeErrorMessage(message: string): string {
  let text = message;
  // Drizzle wraps: "Failed query: select …\nparams: …"
  if (/^Failed query:/i.test(text)) {
    const relation =
      text.match(/\b(?:relation|table)\s+"?([a-zA-Z0-9_.]+)"?/i)?.[1] ??
      text.match(/\bfrom\s+"([a-zA-Z0-9_]+)"/i)?.[1];
    text = relation
      ? `Failed query involving ${relation}`
      : "Failed database query";
  }
  text = text.replace(/postgresql:\/\/[^\s]+/gi, "postgresql://***");
  text = text.replace(/\nparams:[\s\S]*$/i, "");
  return text.slice(0, 200);
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
