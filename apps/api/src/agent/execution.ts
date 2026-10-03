import {
  createFinishTool,
  defineTool,
  getRunMetricsFromError,
  isSuccessfulStop,
  providerSafeToolName,
  runAgent,
  runModel,
  type AgentRunMetrics,
  type AgentToolSet,
  type V3Model,
} from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";

import type { DocxEngineBinding } from "@opensuite/engine-client";
import { docxCapabilityFingerprint } from "@opensuite/engine-client";

import type { CredentialSource } from "../ai-preferences/types.js";
import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { DocumentService } from "../documents/service.js";
import type { ManagedUsagePolicy } from "../managed-usage-policy.js";
import type { ModelUsageService } from "../model-usage/service.js";
import type {
  AgentRunReportEngine,
  AgentRunReportSink,
  DocumentVersionAdvance,
} from "./agent-run-report.js";
import {
  formatDocumentSaved,
  formatDocumentTarget,
  formatValidationChecks,
  logAgentLine,
  logAgentRunBanner,
} from "./agent-run-log.js";
import {
  composeProjectMessages,
  loadHistory,
  prepareContext,
  toolContext,
} from "./agent-context.js";
import {
  createRunEventHandler,
  createTranscriptCollector,
  emitRunReport,
  isFinishTool,
  isInputNeededTool,
  summarizeError,
} from "./run-events.js";
import {
  MAX_MODEL_TURNS,
  boundedStopMessage,
  failureCodeForStopReason,
  finalizeCompletedRun,
  keepLeaseUntilFinished,
  persistTranscript,
  releaseLease,
  settleTerminalRunFailure,
} from "./run-settlement.js";
import { createToolSurface } from "./tool-groups.js";
import { createCapabilityTelemetry, type CapabilityEventSink } from "./capabilities/telemetry.js";
import { projectLoadedInstructions } from "./capabilities/instruction-projection.js";
import { createRunTrace, traceModelSettings, type RunTrace } from "./run-trace.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { verifyDocumentUpdate } from "./document-verification.js";
import { SlimDocumentStructureCache } from "./document-retrieval.js";
import { generateThreadTitle } from "./thread-title.js";
import { estimateTokens } from "./context-projection.js";
import { compactThreadContext, logContextCompaction } from "./context-compaction.js";
import { buildAgentOperatingInstruction, buildDocumentUpdateInstruction } from "./operating-instruction.js";
import { createWorkspaceSearchTool } from "./workspace-search.js";
import { refersToOpenDocument, requestsDocumentChange } from "./document-target.js";
import {
  type AgentMessage,
  type AgentPersistenceService,
  type AgentRun,
  type AgentThread,
} from "./persistence.js";
import {
  type AgentExecutionLeaseService,
} from "./execution-lease.js";

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
  | { readonly type: "document.renamed"; readonly runId: string; readonly at: string; readonly documentId: string; readonly name: string }
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
  /** Actual request cap, when configured; catalog maxOutputTokens is only a ceiling. */
  readonly outputTokenLimit?: number;
}

export type AgentExecutionErrorCode =
  | "THREAD_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "AI_CONFIGURATION_INVALID"
  | "AGENT_EXECUTION_BUSY"
  | "INVALID_CONTINUATION"
  | "AGENT_EXECUTION_FAILED"
  | "AGENT_PERSISTENCE_FAILED"
  | "DOCX_ENGINE_UNAVAILABLE";

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
  > & Partial<Pick<DocumentService, "rename">>;
  readonly resolveModel: (userId: string) => Promise<ResolvedV3ExecutionModel>;
  readonly docxBinding?: DocxEngineBinding;
  readonly modelUsage?: ModelUsageService;
  readonly managedUsagePolicy?: ManagedUsagePolicy;
  readonly agentRunReportSink?: AgentRunReportSink;
  readonly capabilityEventSink?: CapabilityEventSink;
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
      const openDocument = await resolvePrimaryDocument(
        deps.documents,
        thread,
        input.userId,
        input.activeDocumentId,
      );
      const creatingNewDocument = /\b(?:create|make|start|draft)\s+(?:a\s+|an\s+|the\s+)?(?:brand\s+)?new\b/i.test(input.instruction);
      if (!deps.docxBinding && requestsDocumentChange(input.instruction) && (
        openDocument?.format === "docx" || creatingNewDocument ||
        (await deps.documents.listInWorkspace(thread.workspaceId, input.userId)).some((document) => document.format === "docx")
      )) {
        throw new AgentExecutionError("DOCX_ENGINE_UNAVAILABLE", "DOCX editing is unavailable because the document engine did not load. Please try again after the API is restarted with the engine available.");
      }
      const primaryDocument = !creatingNewDocument && refersToOpenDocument(input.instruction) ? openDocument : null;
      const persistedWorkingDocumentIds = await deps.persistence.listWorkingDocumentIds({
        threadId: thread.id,
        ownerUserId: input.userId,
      });
      const workingDocumentIds = [...new Set([
        ...persistedWorkingDocumentIds,
        ...(openDocument ? [openDocument.documentId] : []),
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

      // Banner logged once retrieval resolves (target/sources known).
      const engineCaps = deps.docxBinding?.getDocxCapabilities();
      const engineIdentity = engineCaps
        ? {
            engineVersion: engineCaps.engineVersion,
            capabilityFingerprint: docxCapabilityFingerprint(engineCaps),
          }
        : undefined;
      const trace = process.env.AGENT_RUN_TRACE === "full" ? createRunTrace({
        runId: started.run.id, threadId: thread.id,
        metadata: { model: typeof model.model === "string" ? model.model : model.model.modelId,
          provider: typeof model.model === "string" ? undefined : model.model.provider, modelSettings: traceModelSettings(model.model),
          workspaceId: thread.workspaceId, documentId: primaryDocument?.documentId ?? null,
          startingVersionId: started.run.baseDocumentVersionId, contextLength: model.contextLength,
          maxOutputTokens: model.outputTokenLimit, maxTurns: MAX_MODEL_TURNS,
          ...(engineIdentity ? { engine: engineIdentity } : {}) },
      }) : undefined;
      let getWorkingDocument = () => null as ReturnType<AgentExecutionHandle["getWorkingDocument"]>;
      const execution = runExecution({
        deps,
        trace,
        model,
        thread,
        userMessage: started.userMessage,
        run: started.run,
        primaryDocumentId: primaryDocument?.documentId ?? null,
        openDocumentId: input.activeDocumentId ?? null,
        primaryDocumentFormat: primaryDocument?.format ?? null,
        structureCache,
        ownerUserId: input.userId,
        instruction: input.instruction,
        submittedDocumentIds: [...new Set(input.documentIds ?? [])],
        workingDocumentIds,
        ...(continuation ? { continuationContext: continuation.context, continuationPreviousRunId: input.continueFromRunId } : {}),
        signal: input.signal,
        liveEvents: input.liveEvents,
        setWorkingDocumentGetter: (getter) => { getWorkingDocument = getter; },
      });
      const result = trace ? execution.then((result) => {
        trace?.write("## Settlement", { run: result.run, assistantMessage: result.assistantMessage });
        return result;
      }, (error: unknown) => {
        trace?.write("## Settlement — Error", error);
        throw error;
      }) : execution;
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

  return { start };
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
  readonly trace?: RunTrace;
  readonly deps: AgentExecutionServiceDeps;
  readonly model: ResolvedV3ExecutionModel;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly primaryDocumentId: string | null;
  readonly openDocumentId: string | null;
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
  const capabilityTelemetry = createCapabilityTelemetry(input.run.id, input.model.usageAttribution?.model ?? "unknown", input.deps.capabilityEventSink);
  let boundTools: Awaited<ReturnType<typeof createPrimaryDocxTools>>;
  let flushAttempted = false;
  let persistenceFailure = false;
  const flushWorking = async () => {
    boundTools?.setModelTurn(null);
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
    const { checkpoint, priorMessages, historyLoad } = await loadHistory({
      persistence: input.deps.persistence,
      threadId: input.thread.id,
      ownerUserId: input.ownerUserId,
      excludeMessageId: input.userMessage.id,
    });
    input.trace?.write("## Context — Checkpoint / Loaded History", { checkpoint, priorMessages });
    input.trace?.write("## Context — Human Turn Counts", {
      ...historyLoad, estimatedHistoricalTokens: estimateTokens(priorMessages.map((message) => message.content).join("\n")),
      latestDocumentVersionId: input.run.baseDocumentVersionId,
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
    let createdDocumentId: string | null = null;
    const initialDocumentId = input.primaryDocumentId;
    const engineCaps = input.deps.docxBinding?.getDocxCapabilities();
    const engineIdentity: AgentRunReportEngine | undefined = engineCaps
      ? {
          engineVersion: engineCaps.engineVersion,
          capabilityFingerprint: docxCapabilityFingerprint(engineCaps),
        }
      : undefined;
    let directVersionId: string | null = null;
    let directWorkingVersions = new Map<string, string>();
    let directMessage: string | undefined;
    let directSnapshotRevision: number | null = 0;
    let directAttemptedRevision = 0;
    let documentView: Record<string, unknown> | undefined;
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
        input.trace?.write("## Document Target", { documentId, versionId });
        logAgentLine(
          formatDocumentTarget(documentNames.get(documentId) ?? documentId.slice(0, 8)),
        );
        directVersionId = directWorkingVersions.get(documentId) === versionId ? versionId : null;
        updateDirectReadGuard(directVersionId !== null);
      },
      onWorkingUpdated: (working) => {
        if (directVersionId) input.trace?.write("### Document View — Dirtied", {
          ...working, snapshotRevision: directSnapshotRevision, dirty: true,
        });
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
        input.trace?.write("## Document Version Created", advanced);
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
        documentNames.set(created.documentId, created.name);
        input.trace?.write("## Document Created", created);
        if (created.kind === "created") createdDocumentId = created.documentId;
        // Duplication preserves DIRECT context only when the source was unchanged.
        if (created.kind === "duplicated" && directVersionId && boundTools?.getWorkingMutationCount() === 0) {
          directVersionId = created.versionId;
          directSnapshotRevision = directAttemptedRevision = 0;
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
      onDocumentRenamed: async (renamed) => {
        documentNames.set(renamed.documentId, renamed.name);
        await input.liveEvents?.emit({ type: "document.renamed", runId: input.run.id, at: new Date().toISOString(), ...renamed });
      },
    });
    input.setWorkingDocumentGetter(() => boundTools?.getWorkingDocument() ?? null);

    const finish = createFinishTool({
      description: "After your concise final response to the user, call this to end the run.",
    });
    const tools: AgentToolSet = {
      ...(boundTools?.tools ?? {}),
      "workspace.search_documents": createWorkspaceSearchTool({
        documents: input.deps.documents,
        ...(input.deps.docxBinding ? { binding: input.deps.docxBinding } : {}),
        ownerUserId: input.ownerUserId,
        workspaceId: input.thread.workspaceId,
      }),
      [finish.name]: finish.tool,
      finish_with_input_needed: defineTool<{ missingInformation: string }, string>({
        kind: "read",
        terminal: true,
        description: "End after your final response when some requested work remains unchanged because human input or source evidence is missing. State the missing information in the final response.",
        inputSchema: jsonSchema({ type: "object", properties: { missingInformation: { type: "string", minLength: 1 } }, required: ["missingInformation"], additionalProperties: false }),
        execute: () => "",
      }),
      request_clarification: defineTool<{ question: string }, string>({
        kind: "read",
        terminal: true,
        description: "Ask one concise, actionable question and end the run when a material contradiction or missing information leaves meaningfully different possible edits. Call this alone, before further edits; the question becomes the user-facing response. Do not include internal tool details.",
        inputSchema: jsonSchema({ type: "object", properties: { question: { type: "string", minLength: 1 } }, required: ["question"], additionalProperties: false }),
        execute: ({ question }) => {
          if (typeof question !== "string" || !question.trim()) throw new Error("A clarification question is required.");
          return question.trim();
        },
      }),
    };
    const readGuard = guardRepeatedReads(
      tools,
      () => boundTools?.getActiveVersionId() ?? null,
      false,
      () => boundTools?.getWorkingRevision() ?? 0,
    );
    const toolSurface = createToolSurface(tools, capabilityTelemetry.record);
    const system = buildAgentOperatingInstruction(
      Object.keys(toolSurface.initialTools).map(providerSafeToolName),
      toolSurface.capabilityIndex,
    ) +
      (requestsDocumentChange(input.instruction)
        ? `\n\n${buildDocumentUpdateInstruction()}`
        : "") +
      (!boundTools?.getActiveDocumentId() && tools["workspace.create_blank_document"]
        ? "\n\nNo document is selected for editing. Create one for a new-document request, or call workspace_select_document with the intended workspace DOCX ID before using document tools."
        : "") +
      "\n\nThe OPEN document in the workspace manifest is context. It is selected automatically only for an explicit request to update this, current, or open document. For other edits, inspect or search as needed, then call workspace_select_document for the target before mutating. Search and inspection do not select a target. Keep edits narrow and preserve unrelated structure and formatting.";

    const { messages, workspaceManifest, context, retrieval, reportRetrieval } = await prepareContext({
      trace: input.trace,
      checkpoint,
      priorMessages,
      system,
      tools: toolSurface.initialTools,
      instruction: input.instruction,
      ...(input.continuationContext ? { continuationContext: input.continuationContext } : {}),
      activeDocumentId: boundTools?.getActiveDocumentId(),
      activeVersionId: boundTools?.getActiveVersionId(),
      model: input.model,
      runShort,
      cache: input.structureCache,
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      workspaceId: input.thread.workspaceId,
      primaryDocumentId: input.primaryDocumentId,
      openDocumentId: input.openDocumentId,
      primaryVersionId: input.run.baseDocumentVersionId,
      submittedDocumentIds: input.submittedDocumentIds,
      workingDocumentIds: input.workingDocumentIds,
    });
    input.trace?.write("## Retrieval — Mode / Constructed Context", { retrievalMode: retrieval?.observation.contextStrategy ?? "skipped", retrieval, context, messages });
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
      directMessage = retrieval.message;
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

    const initialMessageCount = messages.length;
    let modelTurn = 0;
    let continuation: Record<string, unknown> | undefined;
    const project = composeProjectMessages({
      retrievalMessage: retrieval?.message ?? workspaceManifest,
      ...(retrieval?.refreshDirectMessage ? { currentDirectMessage: () => directMessage } : {}),
      safeToolResultNames: input.model.usageAttribution?.provider === "openrouter",
      directVersionId: () => directVersionId,
      currentVersionId: () => directMessage ? boundTools?.getActiveVersionId() ?? null : null,
      suppressedReadCount: () => readGuard.suppressedCount(),
    });
    const projectMessages: NonNullable<Parameters<typeof runAgent>[0]["projectMessages"]> = async (messages) => {
      if (directVersionId && retrieval?.refreshDirectMessage) {
        const workingRevision = boundTools?.getWorkingRevision() ?? 0;
        const dirty = workingRevision !== directAttemptedRevision;
        const startedAt = performance.now();
        let refreshError: string | undefined;
        if (dirty) {
          directAttemptedRevision = workingRevision;
          // Clear first: a failed refresh must never re-inject the old snapshot.
          directMessage = undefined;
          directSnapshotRevision = null;
          readGuard.setCompleteDirect(false);
          try {
            const working = boundTools?.getWorkingDocument();
            if (!working) throw new Error("Current working document is unavailable");
            directMessage = await retrieval.refreshDirectMessage({ ...working, name: documentNames.get(working.documentId) ?? working.documentId });
            directSnapshotRevision = workingRevision;
            readGuard.setCompleteDirect(true);
          } catch (error) {
            refreshError = summarizeError(error);
            console.warn(`[agent] direct_view_refresh_failed revision=${workingRevision} reason=${refreshError}`);
          }
        }
        documentView = { strategy: "direct", workingRevision, snapshotRevision: directSnapshotRevision,
          dirty, refreshed: dirty && directMessage !== undefined, available: directMessage !== undefined,
          characters: directMessage?.length ?? 0, estimatedTokens: estimateTokens(directMessage ?? ""),
          durationMs: dirty ? performance.now() - startedAt : 0, ...(refreshError ? { refreshError } : {}) };
      } else documentView = undefined;
      const workingRevision = boundTools?.getWorkingRevision() ?? 0;
      const projected = project(messages);
      // projectMessages runs before the model request. A load call later in this turn
      // can only change this guidance on the next request.
      const currentTools = toolSurface.session.projectTools();
      const instructionBudget = context.safeInputBudgetTokens === undefined ? undefined : Math.max(0,
        context.safeInputBudgetTokens - estimateTokens(system) - estimateTokens(toolContext(currentTools)) - estimateTokens(JSON.stringify(projected)),
      );
      const guidance = projectLoadedInstructions(toolSurface.session, instructionBudget);
      const modelMessages = guidance ? [...projected, guidance.message] : projected;
      const inRunMessages = projected.slice(initialMessageCount);
      continuation = { turn: ++modelTurn, mode: "provider",
        priorAssistantReasoningReplayed: inRunMessages.some((message) => message.role === "assistant" &&
          Array.isArray(message.content) && message.content.some((part) => part.type === "reasoning")),
        priorSuccessfulToolExchangesReplayed: inRunMessages.some((message) => message.role === "tool" &&
          Array.isArray(message.content) && message.content.some((part) => part.type === "tool-result" &&
            part.output.type !== "error-text" && part.output.type !== "error-json" && part.output.type !== "execution-denied" &&
            !("value" in part.output && part.output.value && typeof part.output.value === "object" && (part.output.value as { ok?: unknown }).ok === false))),
        estimatedInRunTokens: estimateTokens(JSON.stringify(inRunMessages)),
        loadedInstructionTokens: guidance?.estimatedTokens ?? 0,
        workingRevision, snapshotRevision: directSnapshotRevision,
        };
      input.trace?.write(`## Turn ${modelTurn} — Continuation`, continuation);
      return modelMessages;
    };

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
          created: createdDocumentId === target.documentId,
          inputNeeded: isInputNeededTool(metrics?.toolCalls.filter((tool) => tool.outcome === "success" && isFinishTool(tool.toolName)).at(-1)?.toolName),
          targetAdvanced: target.fromVersionId !== target.versionId,
          sourcesUnchanged: input.workingDocumentIds.every((id) => id === target.documentId)
            ? true
            : retrieval && input.workingDocumentIds.every((id) => id === target.documentId || sources.some((source) => source.documentId === id))
              ? sources.every((item, index) => currentSources[index]?.latestVersion.id === item.versionId)
              : null,
        });
        transcript.validation(checks);
        input.trace?.write("## Validation", checks);
        logAgentLine(formatValidationChecks(checks));
      } catch {
        input.trace?.write("## Validation", [{ id: "verification", status: "fail", message: "Saved document could not be verified" }]);
        transcript.validation([{ id: "verification", status: "fail", message: "Saved document could not be verified" }]);
        logAgentLine(formatValidationChecks([{ status: "fail", message: "Saved document could not be verified" }]));
      }
    };
    let result;
    const handleRunEvent = createRunEventHandler({
      liveEvents: input.liveEvents,
      runId: input.run.id,
      messageId,
      transcript,
      modelLabel,
      maxOutputTokens: input.model.outputTokenLimit,
    });
    try {
      result = await executeAgent({
        model: input.model.model,
        system,
        messages,
        projectMessages,
        projectTools: toolSurface.projectTools,
        tools: toolSurface.tools,
        signal: input.signal,
        runId: runShort,
        maxTurns: MAX_MODEL_TURNS,
        ...(input.trace ? { onDiagnostic: (event, data) => input.trace!.diagnostic(event, data,
          toolSurface.summary().groupsLoaded, event === "model_request" ? { ...context, ...(documentView ? { documentView } : {}), continuation } : undefined) } : {}),
        ...(input.model.outputTokenLimit !== undefined
          ? { maxOutputTokens: input.model.outputTokenLimit }
          : {}),
        onEvent: (event) => {
          capabilityTelemetry.runtimeEvent(event, toolSurface.session);
          input.trace?.event(event);
          if (event.type === "model_turn_started") boundTools?.setModelTurn(event.turn);
          if (event.type === "model_turn_completed") toolSurface.recordTurn(event, runShort);
          return handleRunEvent(event);
        },
      });
      await flushWorking();
      await verifySavedDocument(result.metrics);
    } catch (error) {
      let terminalError = error;
      try { await flushWorking(); } catch (flushError) { terminalError = flushError; }
      await verifySavedDocument(result?.metrics ?? getRunMetricsFromError(error));
      await emitRunReport({
        trace: input.trace,
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
        ...(engineIdentity ? { engine: engineIdentity } : {}),
        retrieval: reportRetrieval,
        context: {
          ...context,
          redundantReadSuppressedCount: readGuard.suppressedCount(),
          continuationPreviousRunId: input.continuationPreviousRunId,
        },
        sink: input.deps.agentRunReportSink,
      });
      throw terminalError;
    } finally {
      console.info(`[agent] tool_surface_summary run=${runShort} ${JSON.stringify(toolSurface.summary())}`);
    }

    await emitRunReport({
      trace: input.trace,
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
      ...(engineIdentity ? { engine: engineIdentity } : {}),
      retrieval: reportRetrieval,
      context: {
        ...context,
        redundantReadSuppressedCount: readGuard.suppressedCount(),
        continuationPreviousRunId: input.continuationPreviousRunId,
      },
      sink: input.deps.agentRunReportSink,
    });

    if (!isSuccessfulStop(result.stopReason)) {
      transcript.finish();
      const boundedStop = result.stopReason === "max_turns" || result.stopReason === "deadline" || result.stopReason === "output_limit";
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
      inputNeeded: result.stopReason === "finish_tool" &&
        isInputNeededTool(result.metrics.toolCalls.filter((call) => call.outcome === "success" && isFinishTool(call.toolName))
          .at(-1)?.toolName),
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
    input.trace?.write("## Run Error", { error, metrics: getRunMetricsFromError(error), cancelled: input.signal?.aborted === true });
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
  } finally {
    await capabilityTelemetry.flush();
  }
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

export type AgentExecutionService = ReturnType<typeof createAgentExecutionService>;
