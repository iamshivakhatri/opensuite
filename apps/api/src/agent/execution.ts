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
import type { ManagedUsagePolicy } from "../managed-usage-policy.js";
import {
  productionModelPricingRegistry,
} from "../model-usage/pricing.js";
import type { ModelUsageService } from "../model-usage/service.js";
import {
  composeAgentRunReport,
  logAgentRunReport,
  type AgentRunReport,
  type AgentRunReportSink,
  type AgentRunReportRetrieval,
  type DocumentTransition,
  type DocumentVersionAdvance,
} from "./agent-run-report.js";
import {
  formatDocumentSaved,
  formatModelTurnCompleted,
  formatModelTurnFirstOutput,
  formatModelTurnStarted,
  formatMutationsApplied,
  formatToolFinished,
  formatToolStarted,
  formatValidationChecks,
  logAgentLine,
  logAgentRunBanner,
  sanitizeLogName,
} from "./agent-run-log.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { verifyDocumentUpdate, type DocumentCheck } from "./document-verification.js";
import {
  retrieveWorkspaceContext,
  SlimDocumentStructureCache,
  formatDocumentMap,
  type DocumentMap,
  type WorkspaceArtifact,
} from "./document-retrieval.js";
import { generateThreadTitle } from "./thread-title.js";
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
  readonly output?: Record<string, unknown>;
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
    toolStarted(toolName?: string) {
      // Final answer text before `finish` stays buffered so finish(finalText)
      // can drop it; flushing here would duplicate agent_message content.
      if (toolName === "finish") return;
      flushNarration();
    },
    toolFinished(toolName: string, status: AgentStepStatus, skipped = false, error?: string) {
      entries.push({
        kind: toolName === "document.inspect" ? "inspect" : "tool",
        status,
        name: toolName,
        summary: skipped ? "Skipped" : status === "completed" ? "Completed" : `Failed${error ? `: ${error.slice(0, 120)}` : ""}`,
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
    validation(checks: readonly DocumentCheck[]) {
      entries.push({ kind: "validation", status: "completed", name: "Document validation", summary: "Document validation", output: { checks } });
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
  | { readonly type: "document.working.updated"; readonly runId: string; readonly at: string; readonly documentId: string; readonly baseVersionId: string; readonly workingRevision: number }
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
  readonly getWorkingDocument: () => { documentId: string; baseVersionId: string; revision: number; bytes: Uint8Array } | null;
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
  readonly managedUsagePolicy?: ManagedUsagePolicy;
  readonly agentRunReportSink?: AgentRunReportSink;
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
      let primaryDocument = await resolvePrimaryDocument(
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
      let editableDocumentId: string | undefined;
      if (workingDocumentIds.length > 1) {
        const documents = await deps.documents.listInWorkspace(thread.workspaceId, input.userId).catch(() => []);
        const namedTargets = documents.filter((document) =>
          workingDocumentIds.includes(document.id) && document.format === "docx" &&
          namesEditTarget(input.instruction, document.name),
        );
        if (namedTargets.length === 1) editableDocumentId = namedTargets[0]!.id;
        if (namedTargets.length === 1 && namedTargets[0]!.id !== primaryDocument?.documentId) {
          primaryDocument = await resolvePrimaryDocument(deps.documents, thread, input.userId, namedTargets[0]!.id);
        }
      }
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

      // Banner logged once retrieval resolves (target/sources known).
      let getWorkingDocument = () => null as ReturnType<AgentExecutionHandle["getWorkingDocument"]>;
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
        editableDocumentId,
        ...(continuation ? { continuationContext: continuation.context, continuationPreviousRunId: input.continueFromRunId } : {}),
        signal: input.signal,
        liveEvents: input.liveEvents,
        setWorkingDocumentGetter: (getter) => { getWorkingDocument = getter; },
      });
      // Background observation/ownership lives in run-manager (not here).
      const protectedResult = lease
        ? keepLeaseUntilFinished(deps.lease!, lease, result)
        : result;
      return { thread, userMessage: started.userMessage, run: started.run, result: protectedResult, getWorkingDocument: () => getWorkingDocument() };
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

function namesEditTarget(instruction: string, filename: string): boolean {
  const name = filename.replace(/\.docx$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:update|edit|revise|refresh|modify)\\s+(?:the\\s+)?${name}\\b`, "i").test(instruction);
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
    (prior.errorCode !== "AGENT_MAX_TURNS" && prior.errorCode !== "AGENT_DEADLINE") ||
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
  const steps = await persistence.listStepsForRun({ runId: prior.id, ownerUserId: input.userId });
  const completed = new Map<string, number>();
  const failures = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "tool" && step.kind !== "inspect") continue;
    const counts = step.status === "completed" ? completed : step.status === "failed" ? failures : null;
    if (counts) counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  }
  const formatCounts = (counts: Map<string, number>) => [...counts]
    .map(([name, count]) => `${name} ×${count}`).join(", ") || "none";
  const failureReasons = [...new Set(steps.filter((step) => step.status === "failed")
    .map((step) => step.summary).filter((summary): summary is string => !!summary && summary !== "Failed"))]
    .slice(0, 4).join("; ");
  return {
    triggeringMessageId: original.id,
    context: `PREVIOUS RUN PROGRESS (run ${prior.id}; stopped: ${prior.errorCode === "AGENT_DEADLINE" ? "deadline" : "max_turns"})\nOriginal task:\n${original.content}\nCompleted tools: ${formatCounts(completed)}\nFailed tools: ${formatCounts(failures)}${failureReasons ? `\nFailure details: ${failureReasons}` : ""}\nBase document version: ${prior.baseDocumentVersionId ?? "none"}. Resume from the CURRENT bound document state. Do not repeat completed work. Read only where current context lacks an exact target or required structure.`,
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
  readonly editableDocumentId?: string;
  readonly continuationContext?: string;
  readonly continuationPreviousRunId?: string;
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
  readonly setWorkingDocumentGetter: (getter: AgentExecutionHandle["getWorkingDocument"]) => void;
}): Promise<AgentExecutionResult> {
  const transcript = createTranscriptCollector();
  let boundTools: Awaited<ReturnType<typeof createPrimaryDocxTools>>;
  let flushAttempted = false;
  let persistenceFailure = false;
  const flushWorking = async () => {
    if (flushAttempted) return;
    flushAttempted = true;
    try {
      await boundTools?.flush();
    } catch {
      persistenceFailure = true;
      throw new AgentExecutionError("AGENT_PERSISTENCE_FAILED", "Could not save agent document changes. The previous version is unchanged.");
    }
  };
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
    const modelLabel = input.model.usageAttribution?.model ?? "unknown";
    if (
      input.model.usageAttribution?.provider === "openrouter" &&
      input.model.usageAttribution.credentialSource === "managed"
    ) {
      await input.deps.managedUsagePolicy?.beforeManagedCall(input.ownerUserId);
    }

    const versionAdvances: DocumentVersionAdvance[] = [];
    let savedTarget: { documentId: string; fromVersionId: string; versionId: string } | null = null;
    const initialDocumentId = input.primaryDocumentId;
    let directVersionId: string | null = null;
    let directWorkingVersions = new Map<string, string>();
    const documentNames = new Map<string, string>();
    let updateDirectReadGuard = (_complete: boolean) => {};
    boundTools = await createPrimaryDocxTools({
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      workspaceId: input.thread.workspaceId,
      documentId: input.primaryDocumentId,
      versionId: input.run.baseDocumentVersionId,
      workingDocumentIds: input.workingDocumentIds,
      ...(input.editableDocumentId ? { editableDocumentId: input.editableDocumentId } : {}),
      onDocumentSelected: ({ documentId, versionId }) => {
        logAgentLine(`Target     ${sanitizeLogName(documentNames.get(documentId) ?? documentId.slice(0, 8))}`);
        directVersionId = directWorkingVersions.get(documentId) === versionId ? versionId : null;
        updateDirectReadGuard(directVersionId !== null);
      },
      onWorkingUpdated: (working) => {
        void input.liveEvents?.emit({
          type: "document.working.updated",
          runId: input.run.id,
          at: new Date().toISOString(),
          documentId: working.documentId,
          baseVersionId: working.baseVersionId,
          workingRevision: working.revision,
        });
      },
      onVersionAdvanced: async (advanced) => {
        logAgentLine(
          formatDocumentSaved(
            documentNames.get(advanced.documentId) ?? advanced.documentId.slice(0, 8),
            advanced.versionNumber,
          ),
        );
        savedTarget = { documentId: advanced.documentId, fromVersionId: advanced.fromVersionId, versionId: advanced.versionId };
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
        // Duplication preserves DIRECT context only when the source was unchanged.
        if (created.kind === "duplicated" && directVersionId && boundTools?.getWorkingMutationCount() === 0) {
          directVersionId = created.versionId;
          updateDirectReadGuard(true);
        } else {
          directVersionId = null;
          updateDirectReadGuard(false);
        }
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
    input.setWorkingDocumentGetter(() => boundTools?.getWorkingDocument() ?? null);

    const finish = createFinishTool({
      description: "After your concise final response to the user, call this to end the run.",
    });
    const tools: AgentToolSet = {
      ...(boundTools?.tools ?? {}),
      [finish.name]: finish.tool,
    };
    const readGuard = guardRepeatedReads(
      tools,
      () => boundTools?.getActiveVersionId() ?? null,
      false,
      () => boundTools?.getWorkingRevision() ?? 0,
    );
    const system = buildAgentOperatingInstruction(Object.keys(tools)) +
      (!boundTools?.getActiveDocumentId() && tools["workspace.create_blank_document"]
        ? "\n\nNo document is active. If the user requests a new document, create it before calling any document tool."
        : "") +
      "\n\nFor requests involving several documents, identify the editable target before mutating. The active document is the default target only when it matches the request. Use workspace.select_document to bind another working-set DOCX before editing. Read source documents with workspace.inspect_document when the supplied context lacks their details. Keep edits narrow and preserve unrelated structure and formatting.";
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
    for (const document of retrieval?.workingSet ?? []) documentNames.set(document.documentId, document.name);
    const targetId = boundTools?.getActiveDocumentId();
    const sources = (retrieval?.workingSet ?? []).filter((document) => document.documentId !== targetId);
    logAgentRunBanner({
      runId: input.run.id,
      model: modelLabel,
      ...(targetId
        ? { target: documentNames.get(targetId) ?? targetId.slice(0, 8) }
        : {}),
      sources: sources.map((document) => document.name),
      ...(retrieval
        ? {
            retrievalMode: retrieval.observation.contextStrategy,
            documentCount: retrieval.workingSet.length,
            contextTokens: estimateTokens(retrieval.message ?? ""),
          }
        : { retrievalMode: "skipped", documentCount: 0 }),
    });
    readGuard.setCompleteDirect(retrieval?.observation.contextStrategy === "direct");
    if (retrieval?.observation.contextStrategy === "direct") {
      directWorkingVersions = new Map(retrieval.workingSet.map((document) => [document.documentId, document.versionId]));
      directVersionId = input.run.baseDocumentVersionId;
      updateDirectReadGuard = (complete) => readGuard.setCompleteDirect(complete);
    }
    if (!input.thread.title?.trim()) {
      const titleStartedAt = Date.now();
      void generateThreadTitle({
        model: input.model.model,
        instruction: input.instruction,
        workingSet: retrieval?.workingSet ?? [],
        documentMaps: retrieval?.documentMaps ?? [],
      })
        .then(async (title) => {
          const generated = title !== null && await input.deps.persistence.setThreadTitleIfMissing({ threadId: input.thread.id, title });
          console.debug(`[agent-title] thread=${input.thread.id.slice(0, 8)} generated=${generated} durationMs=${Date.now() - titleStartedAt} model=${input.model.usageAttribution?.model ?? "unknown"}`);
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.debug(`[agent-title] thread=${input.thread.id.slice(0, 8)} generated=false durationMs=${Date.now() - titleStartedAt} model=${input.model.usageAttribution?.model ?? "unknown"} reason=${reason.slice(0, 120)}`);
        });
    }
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
        ? [{ role: "user" as const, content: `${input.continuationContext}\nCurrent document ID: ${boundTools?.getActiveDocumentId() ?? "none"}; current version: ${boundTools?.getActiveVersionId() ?? "none"}.` }]
        : []),
      { role: "user", content: input.instruction },
    ];

    const inRunStats = createInRunObservationStats();
    const projectMessages = composeProjectMessages({
      retrievalMessage: retrieval?.message,
      safeToolResultNames: input.model.usageAttribution?.provider === "openrouter",
      directVersionId: () => directVersionId,
      currentVersionId: () => boundTools?.getWorkingRevision() ? null : boundTools?.getActiveVersionId() ?? null,
      suppressedReadCount: () => readGuard.suppressedCount(),
      tools,
      stats: inRunStats,
    });

    // The one API → agent-core-v3 execution call.
    const executeAgent = input.deps.runAgent ?? runAgent;
    const verifySavedDocument = async (metrics?: AgentRunMetrics) => {
      if (!savedTarget || !boundTools?.getWorkingMutationCount() || !input.deps.docxBinding) return;
      const target = savedTarget as { documentId: string; fromVersionId: string; versionId: string };
      try {
        const sources = (retrieval?.workingSet ?? []).filter((item) => item.documentId !== target.documentId);
        const [before, after, ...currentSources] = await Promise.all([
          input.deps.documents.readExactVersionBytes({ documentId: target.documentId, versionId: target.fromVersionId, ownerUserId: input.ownerUserId }),
          input.deps.documents.readExactVersionBytes({ documentId: target.documentId, versionId: target.versionId, ownerUserId: input.ownerUserId }),
          ...sources.map((item) => input.deps.documents.getOwnedDocument({ documentId: item.documentId, ownerUserId: input.ownerUserId })),
        ]);
        const checks = await verifyDocumentUpdate({
          binding: input.deps.docxBinding,
          before: new Uint8Array(before), after: new Uint8Array(after), instruction: input.instruction,
          successfulMutations: metrics?.toolCalls.filter((tool) => tool.kind === "mutate" && tool.outcome === "success").map((tool) => tool.toolName),
          targetAdvanced: target.fromVersionId !== target.versionId,
          sourcesUnchanged: input.workingDocumentIds.every((id) => id === target.documentId)
            ? true
            : retrieval && input.workingDocumentIds.every((id) => id === target.documentId || sources.some((source) => source.documentId === id))
              ? sources.every((item, index) => currentSources[index]?.latestVersion.id === item.versionId)
              : null,
        });
        transcript.validation(checks);
        logAgentLine(formatValidationChecks(checks));
      } catch {
        transcript.validation([{ id: "verification", status: "fail", message: "Saved document could not be verified" }]);
        logAgentLine(formatValidationChecks([{ status: "fail", message: "Saved document could not be verified" }]));
      }
    };
    let result;
    try {
      const toolStartedAt = new Map<string, number>();
      result = await executeAgent({
        model: input.model.model,
        system,
        messages,
        projectMessages,
        tools,
        signal: input.signal,
        runId: runShort,
        maxTurns: MAX_MODEL_TURNS,
        onEvent: (event) => {
          if (event.type === "model_turn_started") {
            logAgentLine(formatModelTurnStarted(event.turn));
          } else if (event.type === "model_turn_first_output") {
            logAgentLine(formatModelTurnFirstOutput(event.elapsedMs));
          } else if (event.type === "model_turn_completed") {
            logAgentLine(
              formatModelTurnCompleted({
                durationMs: event.durationMs,
                inputTokens: event.inputTokens,
                cachedInputTokens: event.cachedInputTokens,
                outputTokens: event.outputTokens,
                reasoningTokens: event.reasoningTokens,
                toolNames: event.toolNames,
              }),
            );
          } else if (event.type === "tool_started") {
            if (event.toolName !== "finish") {
              toolStartedAt.set(event.toolCallId, Date.now());
              logAgentLine(formatToolStarted(event.toolName));
            }
          } else if (
            event.type === "tool_completed" ||
            event.type === "tool_failed" ||
            event.type === "tool_skipped"
          ) {
            if (event.toolName !== "finish") {
              const elapsed = Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now());
              const code =
                event.type === "tool_failed"
                  ? event.error
                  : event.type === "tool_skipped"
                    ? event.reason
                    : undefined;
              logAgentLine(
                formatToolFinished({
                  ok: event.type === "tool_completed",
                  durationMs: elapsed,
                  skipped: event.type === "tool_skipped",
                  ...(code && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
                    ? { code }
                    : event.type === "tool_failed"
                      ? { code: "TOOL_FAILED" }
                      : code
                        ? { code }
                        : {}),
                }),
              );
              toolStartedAt.delete(event.toolCallId);
            }
          }
          return relayEvent(event, input.liveEvents, input.run.id, messageId, transcript);
        },
      });
      const mutationCount = boundTools?.getWorkingMutationCount() ?? 0;
      if (mutationCount > 0) logAgentLine(formatMutationsApplied(mutationCount));
      await flushWorking();
      await verifySavedDocument(result.metrics);
    } catch (error) {
      let terminalError = error;
      try { await flushWorking(); } catch (flushError) { terminalError = flushError; }
      await verifySavedDocument(result?.metrics ?? getRunMetricsFromError(error));
      await emitRunReport({
        runId: input.run.id,
        instruction: input.instruction,
        model: input.model,
        metrics: result?.metrics ?? getRunMetricsFromError(error),
        ...(result ? { stopReason: result.stopReason } : {}),
        cancelled: input.signal?.aborted === true && !persistenceFailure,
        thrown: true,
        initialDocumentId,
        initialVersionId: input.run.baseDocumentVersionId,
        finalDocumentId: boundTools?.getActiveDocumentId() ?? initialDocumentId,
        finalVersionId: boundTools?.getActiveVersionId() ?? input.run.baseDocumentVersionId,
        versionAdvances,
        workingMutationCount: boundTools?.getWorkingMutationCount() ?? 0,
        documentTransitions: boundTools?.getTransitions() ?? [],
        retrieval: reportRetrieval,
        context: {
          ...context,
          inRunObservationsCompacted: inRunStats.observationsCompacted,
          estimatedInRunTokensBefore: inRunStats.estimatedInRunTokensBefore,
          estimatedInRunTokensAfter: inRunStats.estimatedInRunTokensAfter,
          maxProjectedInputTokens: inRunStats.maxProjectedInputTokens,
          redundantReadSuppressedCount: readGuard.suppressedCount(),
          continuationPreviousRunId: input.continuationPreviousRunId,
        },
        sink: input.deps.agentRunReportSink,
      });
      throw terminalError;
    }

    await emitRunReport({
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
      workingMutationCount: boundTools?.getWorkingMutationCount() ?? 0,
      documentTransitions: boundTools?.getTransitions() ?? [],
      retrieval: reportRetrieval,
      context: {
        ...context,
        inRunObservationsCompacted: inRunStats.observationsCompacted,
        estimatedInRunTokensBefore: inRunStats.estimatedInRunTokensBefore,
        estimatedInRunTokensAfter: inRunStats.estimatedInRunTokensAfter,
        maxProjectedInputTokens: inRunStats.maxProjectedInputTokens,
        redundantReadSuppressedCount: readGuard.suppressedCount(),
        continuationPreviousRunId: input.continuationPreviousRunId,
      },
      sink: input.deps.agentRunReportSink,
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
        await input.deps.managedUsagePolicy?.afterUsageRecorded(usage);
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
      managedUsagePolicy: input.deps.managedUsagePolicy,
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
    let terminalError = error;
    if (!flushAttempted) {
      try { await flushWorking(); } catch (flushError) { terminalError = flushError; }
    }
    return settleTerminalRunFailure({
      error: terminalError,
      cancelled: input.signal?.aborted === true && !persistenceFailure,
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
  readonly workingSet: readonly WorkspaceArtifact[];
  readonly documentMaps: readonly DocumentMap[];
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
      workingSet: retrieved.workingSet,
      documentMaps: retrieved.documentMaps,
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

/** Version identity resets the read budget automatically after a mutation. */
export function guardRepeatedReads(
  tools: AgentToolSet,
  currentVersionId: () => string | null,
  completeDirect: boolean,
  currentWorkingRevision: () => number = () => 0,
) {
  let direct = completeDirect;
  const currentState = () => `${currentVersionId() ?? "unbound"}:${currentWorkingRevision()}`;
  let directVersion = completeDirect ? currentState() : null;
  let suppressed = 0;
  const attempts = new Map<string, number>();
  for (const name of ["document.inspect", "document.find"] as const) {
    const original = tools[name];
    if (!original?.execute) continue;
    const execute = original.execute;
    tools[name] = {
      ...original,
      execute: async (args: any, context: any) => {
        const version = currentVersionId() ?? "unbound";
        const state = currentState();
        const key = `${state}:${name}:${JSON.stringify(args)}`;
        const repeated = attempts.get(key) ?? 0;
        const broadInspect = name === "document.inspect" && (args as { kind?: string }).kind !== "context";
        const readsOfThisKind = [...attempts].reduce((sum, [item, count]) =>
          item.startsWith(`${state}:${name}:`) ? sum + count : sum, 0);
        const allReadsForState = [...attempts].reduce((sum, [item, count]) =>
          item.startsWith(`${state}:document.inspect:`) || item.startsWith(`${state}:document.find:`) ? sum + count : sum, 0);
        // DIRECT already supplied the whole document before the model call.
        const completeAndUnchanged = direct && state === directVersion;
        const tooManyBroadReads = (broadInspect || name === "document.find") &&
          readsOfThisKind >= (name === "document.find" ? 3 : 1);
        if (repeated >= 2 || (completeAndUnchanged && (allReadsForState >= 4 || tooManyBroadReads))) {
          suppressed += 1;
          return { ok: true, redundantReadSuppressed: true, versionId: version,
            message: "Read skipped: the unchanged document content is already in your context. Do not inspect again until the document changes. Make the requested edit or finish." };
        }
        attempts.set(key, repeated + 1);
        try {
          const result = await execute(args, context);
          if (result && typeof result === "object" && "ok" in result && result.ok === false) {
            if (repeated) attempts.set(key, repeated);
            else attempts.delete(key);
          }
          return result;
        } catch (error) {
          if (repeated) attempts.set(key, repeated);
          else attempts.delete(key);
          throw error;
        }
      },
    };
  }
  return { setCompleteDirect(value: boolean) { direct = value; directVersion = value ? currentState() : null; }, suppressedCount() { return suppressed; } };
}

/**
 * Compose Phase 6 first-turn retrieval with C7 in-run observation projection.
 * Retrieval injects once; C7 runs every turn on the model-facing view only.
 */
export function composeProjectMessages(input: {
  readonly retrievalMessage?: string;
  readonly safeToolResultNames?: boolean;
  readonly directVersionId?: string | null | (() => string | null);
  readonly currentVersionId?: () => string | null;
  readonly suppressedReadCount?: () => number;
  readonly tools: AgentToolSet;
  readonly stats: ReturnType<typeof createInRunObservationStats>;
}): (messages: readonly ModelMessage[]) => readonly ModelMessage[] {
  const firstTurn = input.retrievalMessage
    ? firstTurnContextProjection(input.retrievalMessage)
    : (messages: readonly ModelMessage[]) => messages;
  const isMutateTool = (toolName: string) =>
    input.tools[toolName]?.kind === "mutate";
  let projectedOnce = false;

  return (messages) => {
    const first = !projectedOnce;
    projectedOnce = true;
    const currentVersion = input.currentVersionId?.();
    const directVersionId = typeof input.directVersionId === "function" ? input.directVersionId() : input.directVersionId;
    const directCurrent = directVersionId && currentVersion === directVersionId;
    const afterFirstTurn = !first && directCurrent && input.retrievalMessage
      ? [...messages, { role: "user" as const, content: input.retrievalMessage }]
      : firstTurn(messages);
    const projected = projectInRunObservations(afterFirstTurn, { isMutateTool });
    accumulateInRunObservationStats(input.stats, projected);
    const withReadReminder = directCurrent && input.suppressedReadCount?.()
      ? [...projected.messages, { role: "user" as const, content: "The complete unchanged document is already above. Repeated reads were skipped. Stop inspecting and perform the requested document changes using the available mutation tools." }]
      : projected.messages;
    if (!input.safeToolResultNames) return withReadReminder;
    return withReadReminder.map((message) => message.role === "tool" && Array.isArray(message.content)
      ? { ...message, content: message.content.map((part) => part.type === "tool-result"
        ? { ...part, toolName: part.toolName.replace(/[^a-zA-Z0-9_-]/g, "_") }
        : part) } as ModelMessage
      : message);
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
    ? `Reached the ${MAX_MODEL_TURNS} AI-turn limit before completing the task.`
    : "Stopped before the task could be completed.";
  return hasVersionAdvance ? `${stopped} Changes made so far were preserved.` : stopped;
}

async function emitRunReport(input: {
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
  readonly workingMutationCount?: number;
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
    readonly redundantReadSuppressedCount?: number;
    readonly continuationPreviousRunId?: string;
  };
  readonly sink?: AgentRunReportSink;
}): Promise<void> {
  if (!input.metrics) return;
  let report: AgentRunReport;
  try {
    const attribution = input.model.usageAttribution;
    const pricing =
      attribution !== undefined
        ? productionModelPricingRegistry.lookup(
            attribution.provider,
            attribution.model,
          )
        : null;
    report = composeAgentRunReport({
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
      workingMutationCount: input.workingMutationCount,
      versionAdvances: input.versionAdvances,
      documentTransitions: input.documentTransitions ?? [],
      ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}),
      context: input.context,
      pricing,
      ...(attribution !== undefined
        ? { pricingProvider: attribution.provider }
        : {}),
    });
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_failed reason=${summarizeError(error)}`,
    );
    return;
  }
  try {
    logAgentRunReport(report);
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_log_failed reason=${summarizeError(error)}`,
    );
  }
  try {
    void Promise.resolve(input.sink?.(report)).catch((error: unknown) => {
      console.error(
        `[agent] run=${input.runId.slice(0, 8)} run_report_sink_failed reason=${summarizeError(error)}`,
      );
    });
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_sink_failed reason=${summarizeError(error)}`,
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
  if (event.type === "tool_started") transcript.toolStarted(event.toolName);
  if (event.type === "tool_completed") transcript.toolFinished(event.toolName, "completed");
  if (event.type === "tool_failed") transcript.toolFinished(event.toolName, "failed", false, event.error);
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
  const knownFailure = describeRunFailure(input.error, input.transcript ?? []);
  const failureCode = input.failureCode ?? knownFailure?.code ?? "AGENT_EXECUTION_FAILED";
  const failureMessage = input.failureMessage ?? knownFailure?.message ?? "Agent execution failed. Please try again.";

  // Idempotent: if already terminal (e.g. outer safety net after settle),
  // do not attempt another status transition or duplicate terminal SSE.
  let alreadyTerminal = false;
  let assistantMessage: AgentMessage | null = null;
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
      if (input.expectedStop && !input.cancelled) {
        assistantMessage = await input.persistence.withTransaction(async (tx) => {
          const message = await input.persistence.appendMessage({
            threadId: input.thread.id,
            ownerUserId: input.ownerUserId,
            role: "assistant",
            content: failureMessage,
          }, tx);
          await input.persistence.updateRunStatus({
            runId: input.run.id,
            ownerUserId: input.ownerUserId,
            status: "failed",
            errorCode: failureCode,
            errorMessage: failureMessage,
            resultMessageId: message.id,
          }, tx);
          return message;
        });
      } else {
        await updateRunAfterError(
          input.persistence,
          input.ownerUserId,
          input.run.id,
          input.cancelled,
          failureCode,
          failureMessage,
        );
      }
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
    assistantMessage,
  };
}

/** Only known, safe reasons reach persisted run status and the Agent Panel. */
export function describeRunFailure(error: unknown, transcript: readonly TranscriptEntry[]): { code: string; message: string } | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "AGENT_PERSISTENCE_FAILED") {
    return { code, message: "Could not save agent document changes. The previous version is unchanged." };
  }
  if (code === "MANAGED_USAGE_DISABLED" || code === "MANAGED_TRIAL_DISABLED") {
    return { code: String(code), message: "Managed AI is unavailable. Add your own API key in AI & Models settings." };
  }
  if (code === "MANAGED_USAGE_EXHAUSTED" || code === "MANAGED_TRIAL_EXHAUSTED") {
    return { code: String(code), message: "Managed AI credits are exhausted. Add your own API key in AI & Models settings." };
  }
  if (code === "MANAGED_USAGE_ACCOUNTING_FAILED" || code === "MANAGED_TRIAL_ACCOUNTING_FAILED") {
    return { code: String(code), message: "Managed AI is temporarily unavailable. Use your own API key or try again later." };
  }
  if (transcript.some((entry) => entry.status === "failed" && entry.summary.includes("NO_ACTIVE_DOCUMENT"))) {
    return { code: "NO_ACTIVE_DOCUMENT", message: "No document was active, and the agent tried to edit before creating one. Retry the request or open a document first." };
  }
  if (error instanceof Error && /Invalid 'input\[\d+\]\.name'/.test(error.message)) {
    return { code: "MODEL_TOOL_NAME_REJECTED", message: "The AI provider rejected a document tool response. Please try another model or contact support." };
  }
  return null;
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
