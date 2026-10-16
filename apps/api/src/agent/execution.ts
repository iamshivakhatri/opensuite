import { createAttachmentVision, type VisionRoute } from "./attachment-vision.js";
import type { StyleProfileService } from "../style-profiles/service.js";
import type { WorkspaceBrandService } from '../workspace-brand/service.js';
import type { WorkspaceAssetService } from '../workspace-brand/assets.js';
import {
  ChatAttachmentError,
  type ChatAttachmentDto,
  type ChatAttachmentService,
} from "../chat-attachments/service.js";
import { requestsSavedStyle, createStyleProfileTools } from "./capabilities/definitions/style-profiles.js";
import { createWorkspaceBrandTools } from './capabilities/definitions/workspace-brand.js';
import { documentSkillPolicy } from './capabilities/definitions/skills/index.js';
import { resolveDocumentAppearance, shouldApplyAutomaticBrand } from '../document-appearance/resolve.js';
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
  type AgentModel,
} from "@opensuite/agent-core";
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
import { unrecoveredFailedMutateToolNames } from "./agent-run-report.js";
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
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";
import { createCapabilityTelemetry, type CapabilityEventSink } from "./capabilities/telemetry/recorder.js";
import { projectLoadedInstructions } from "./capabilities/runtime/instruction-projection.js";
import { createStandaloneCapabilityTools } from "./capabilities/catalog.js";
import { createRunTrace, traceModelSettings, type RunTrace } from "./run-trace.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import {
  BLOCKING_VERIFICATION_IDS,
  hasBlockingVerificationFailure,
  verifyDocumentUpdate,
  type DocumentCheck,
} from "./document-verification.js";
import { SlimDocumentStructureCache } from "./document-retrieval.js";
import { generateThreadTitle } from "./thread-title.js";
import { recordModelUsage, type ModelCallUsage } from "./usage-accounting.js";
import { estimateTokens } from "./context-projection.js";
import type { AttachmentExtractionService } from "../chat-attachments/extraction.js";
import { ATTACHMENT_SOURCE_POLICY, createAttachmentEvidence, createAttachmentTools } from "./attachment-evidence.js";
import { compactThreadContext, logContextCompaction } from "./context-compaction.js";
import { buildAgentOperatingInstruction, buildDocumentUpdateInstruction } from "./operating-instruction.js";
import { createWorkspaceSearchTool } from "./workspace-search.js";
import { requestsDocumentChange, requestsNewDocument, resolveDocumentTarget } from "./document-target.js";
import { loadRunContinuation, type SavedContinuation } from './run-continuation.js';
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

export interface ResolvedExecutionModel {
  readonly resolveVision?: () => Promise<VisionRoute>;
  readonly model: AgentModel;
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
  | "DOCX_ENGINE_UNAVAILABLE"
  | "SAVED_STYLE_NOT_APPLIED"
  | "INVALID_ATTACHMENTS"
  | "ATTACHMENT_NOT_READY";

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
  readonly attachmentIds?: readonly string[];
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
  > & Partial<Pick<DocumentService, "rename" | "readVersionForEditing">>;
  readonly resolveModel: (userId: string) => Promise<ResolvedExecutionModel>;
  readonly docxBinding?: DocxEngineBinding;
  readonly styleProfiles?: StyleProfileService;
  readonly workspaceBrand?: Pick<WorkspaceBrandService, 'get'>;
  readonly workspaceAssets?: Pick<WorkspaceAssetService, 'readBytes' | 'listImages'>;
  readonly chatAttachments?: Pick<ChatAttachmentService, "bindToMessage" | "metadataForIds">;
  readonly attachmentExtraction?: AttachmentExtractionService;
  readonly modelUsage?: ModelUsageService;
  readonly managedUsagePolicy?: ManagedUsagePolicy;
  readonly agentRunReportSink?: AgentRunReportSink;
  readonly capabilityEventSink?: CapabilityEventSink;
  readonly lease?: AgentExecutionLeaseService;
  /** Test seam — production uses agent-core `runAgent`. */
  readonly runAgent?: typeof runAgent;
  /** Test seam — production uses agent-core `runModel` for compaction. */
  readonly runModel?: typeof runModel;
}

/** Product shell: resolve and persist here; execute once in agent-core. */
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
      if (continuation) {
        const latest = (await deps.persistence.listRunsForTriggerMessages({ threadId: thread.id, ownerUserId: input.userId,
          messageIds: [continuation.triggeringMessageId] }))[0];
        if (latest?.id !== input.continueFromRunId) throw new AgentExecutionError('INVALID_CONTINUATION', 'This task already has a newer execution. Continue its latest unfinished run.');
      }
      const model = await resolveModel(deps, input.userId);
      const targetInstruction = continuation?.instruction ?? input.instruction;
      const creatingNewDocument = requestsNewDocument(targetInstruction);
      const openDocument = creatingNewDocument || continuation ? null : await resolvePrimaryDocument(
        deps.documents,
        thread,
        input.userId,
        continuation ? undefined : input.activeDocumentId,
      );
      let workspaceDocuments: Awaited<ReturnType<DocumentService["listInWorkspace"]>> | undefined;
      if (requestsDocumentChange(targetInstruction) && !creatingNewDocument && !continuation?.documentId) {
        workspaceDocuments = await deps.documents.listInWorkspace(thread.workspaceId, input.userId);
      }
      if (!deps.docxBinding && requestsDocumentChange(targetInstruction) && (
        openDocument?.format === "docx" || creatingNewDocument ||
        (workspaceDocuments ?? await deps.documents.listInWorkspace(thread.workspaceId, input.userId)).some((document) => document.format === "docx")
      )) {
        throw new AgentExecutionError("DOCX_ENGINE_UNAVAILABLE", "DOCX editing is unavailable because the document engine did not load. Please try again after the API is restarted with the engine available.");
      }
      const targetDocumentId = continuation ? continuation.documentId : resolveDocumentTarget({
        instruction: targetInstruction,
        openDocumentId: openDocument?.documentId ?? null,
        documentIds: input.documentIds ?? [],
        documents: workspaceDocuments ?? [],
      });
      const primaryDocument = targetDocumentId === openDocument?.documentId ? openDocument
        : targetDocumentId ? await resolvePrimaryDocument(deps.documents, thread, input.userId, targetDocumentId, workspaceDocuments) : null;
      if (continuation && primaryDocument && deps.documents.readVersionForEditing) {
        const current = await deps.documents.readVersionForEditing({ documentId: primaryDocument.documentId,
          versionId: primaryDocument.versionId, ownerUserId: input.userId });
        if (current.draftId !== (continuation.saved.savedDraftId ?? null)) {
          throw new AgentExecutionError('INVALID_CONTINUATION', 'The document draft changed since this task stopped. Start a new request.');
        }
      }
      const persistedWorkingDocumentIds = await deps.persistence.listWorkingDocumentIds({
        threadId: thread.id,
        ownerUserId: input.userId,
      });
      const submittedDocumentIds = [...new Set([...(continuation?.documentIds ?? []), ...(input.documentIds ?? [])])];
      const submittedAttachmentIds = [...new Set([
        ...(continuation?.attachmentIds ?? []),
        ...(input.attachmentIds ?? []),
      ])];
      const workingDocumentIds = [...new Set([
        ...persistedWorkingDocumentIds,
        ...(openDocument ? [openDocument.documentId] : []),
        ...(primaryDocument ? [primaryDocument.documentId] : []),
        ...submittedDocumentIds,
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
            attachmentIds: submittedAttachmentIds,
          },
          tx,
        );
        let boundAttachments: ChatAttachmentDto[] = [];
        if (submittedAttachmentIds.length > 0) {
          if (!deps.chatAttachments) {
            throw new AgentExecutionError(
              "INVALID_ATTACHMENTS",
              "Chat attachments are unavailable",
            );
          }
          try {
            boundAttachments = await deps.chatAttachments.bindToMessage(
              {
                workspaceId: thread.workspaceId,
                userId: input.userId,
                threadId: thread.id,
                messageId: userMessage.id,
                attachmentIds: submittedAttachmentIds,
              },
              tx,
            );
          } catch (error) {
            if (error instanceof ChatAttachmentError) {
              throw new AgentExecutionError(
                error.code === "ATTACHMENT_NOT_READY"
                  ? "ATTACHMENT_NOT_READY"
                  : "INVALID_ATTACHMENTS",
                error.message,
              );
            }
            throw error;
          }
          if (boundAttachments.length !== submittedAttachmentIds.length) {
            throw new AgentExecutionError(
              "INVALID_ATTACHMENTS",
              "One or more attachments are missing or inaccessible",
            );
          }
        }
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
        return { userMessage, run, boundAttachments };
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
      const baseInstruction = continuation?.instruction ?? input.instruction;
      const instruction = deps.attachmentExtraction ? baseInstruction : appendAttachmentMetadataNote(
        baseInstruction,
        started.boundAttachments,
      );
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
        workspaceDocuments,
        ownerUserId: input.userId,
        instruction,
        submittedDocumentIds,
        submittedAttachmentIds,
        workingDocumentIds,
        ...(continuation ? { continuationPreviousRunId: input.continueFromRunId,
          loadedCapabilityIds: continuation.loadedCapabilityIds,
          savedContinuation: continuation.saved } : {}),
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
): Promise<ResolvedExecutionModel> {
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
): Promise<{ readonly triggeringMessageId: string; readonly saved: SavedContinuation; readonly instruction: string; readonly documentIds: readonly string[]; readonly attachmentIds: readonly string[]; readonly documentId: string | null; readonly loadedCapabilityIds: readonly string[] }> {
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
  let saved: SavedContinuation | undefined;
  try { saved = await loadRunContinuation(persistence, prior, input.userId, steps); }
  catch { throw new AgentExecutionError('INVALID_CONTINUATION', 'The saved execution context is unavailable. Start a new request.'); }
  if (!saved) throw new AgentExecutionError('INVALID_CONTINUATION', 'This older run has no saved execution context. Start a new request.');
  return {
    saved,
    triggeringMessageId: original.id,
    instruction: original.content,
    documentIds: original.documentIds ?? [],
    attachmentIds: original.attachmentIds ?? [],
    loadedCapabilityIds: ([...steps].reverse().map((step) => step.output?.loadedCapabilityIds)
      .find(Array.isArray) ?? []).filter((id): id is string => typeof id === "string"),
    documentId: saved.activeDocumentId,
  };
}

/** Metadata-only note for Part 3; contents are not loaded into the model. */
function appendAttachmentMetadataNote(
  instruction: string,
  attachments: readonly ChatAttachmentDto[],
): string {
  if (attachments.length === 0) return instruction;
  const lines = attachments.map(
    (attachment) =>
      `- ${attachment.filename} (${attachment.mediaType}, ${attachment.sizeBytes} bytes, id=${attachment.id})`,
  );
  return `${instruction}\n\nChat attachments (metadata only; file contents are not loaded in this turn):\n${lines.join("\n")}`;
}

async function resolvePrimaryDocument(
  documents: Pick<DocumentService, "getOwnedDocument">,
  thread: AgentThread,
  userId: string,
  activeDocumentId: string | undefined,
  workspaceDocuments?: Awaited<ReturnType<DocumentService["listInWorkspace"]>>,
): Promise<{ documentId: string; versionId: string; format: string } | null> {
  const documentId = activeDocumentId ?? thread.documentId;
  if (!documentId) return null;
  try {
    const document = workspaceDocuments?.find((document) => document.id === documentId)
      ?? await documents.getOwnedDocument({ documentId, ownerUserId: userId });
    if (document.workspaceId !== thread.workspaceId) {
      throw new AgentExecutionError("DOCUMENT_NOT_FOUND", "Document is not in this workspace");
    }
    return { documentId, versionId: document.latestVersion.id, format: document.format };
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError("DOCUMENT_NOT_FOUND", "Document not found for agent run");
  }
}

async function applyAutomaticWorkspaceAppearance(input: {
  readonly createdDocumentId?: string | null;
  readonly deps: AgentExecutionServiceDeps;
  readonly toolSurface: ReturnType<typeof createToolSurface>;
  readonly boundTools: NonNullable<Awaited<ReturnType<typeof createPrimaryDocxTools>>>;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly getBrand: () => ReturnType<WorkspaceBrandService['get']>;
  readonly includeLogo?: boolean;
}) {
  if (!input.deps.workspaceBrand) return;
  const documentId = input.boundTools.getActiveDocumentId();
  const isNewDocument = !!documentId && (input.createdDocumentId === documentId || input.boundTools.getTransitions().some((item) => item.kind === 'created' && item.toDocumentId === documentId));
  const policy = [...input.toolSurface.session.loaded]
    .sort()
    .map(documentSkillPolicy)
    .find((item) => item?.channels.length);
  if (!shouldApplyAutomaticBrand({ isNewDocument, policy, instruction: input.instruction })) return;
  const brand = await input.getBrand();
  if (!brand) return;
  const wantsLogo = input.includeLogo !== false && policy!.channels.includes('logo') && !!brand.logoAssetId;
  const workspaceLogo = wantsLogo && input.deps.workspaceAssets
    ? await input.deps.workspaceAssets.readBytes(input.workspaceId, input.ownerUserId, brand.logoAssetId!).catch((error) => {
      console.warn('[agent] workspace logo unavailable', error);
      return null;
    })
    : undefined;
  const savedStyle = input.boundTools.getAppliedStyle();
  const appearance = resolveDocumentAppearance({
    policy: policy!,
    workspaceBrand: brand,
    isNewDocument,
    includeLogo: input.includeLogo,
    ...(wantsLogo ? { workspaceLogo } : {}),
    ...(savedStyle ? { savedStyle } : {}),
  });
  if (Object.keys(appearance.provenance).length) {
    const fidelity = await input.boundTools.applyResolvedAppearance(appearance);
    const workspaceFields = fidelity.fields.filter((field) => field.source === 'workspace_brand');
    const counts = Object.fromEntries(['matched', 'mismatched', 'not_applicable', 'unsupported'].map((status) => [
      status,
      workspaceFields.filter((field) => field.status === status).length,
    ]));
    const mismatchedFields = workspaceFields.filter((field) => field.status === 'mismatched').map((field) => field.field);
    console.info(`[agent] appearance workspace_brand ${JSON.stringify({ ...counts, ...(mismatchedFields.length ? { mismatchedFields } : {}) })}`);
  }
}

async function runExecution(input: {
  readonly trace?: RunTrace;
  readonly deps: AgentExecutionServiceDeps;
  readonly model: ResolvedExecutionModel;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly primaryDocumentId: string | null;
  readonly openDocumentId: string | null;
  readonly primaryDocumentFormat: string | null;
  readonly structureCache: SlimDocumentStructureCache;
  readonly workspaceDocuments?: Awaited<ReturnType<DocumentService["listInWorkspace"]>>;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly submittedDocumentIds: readonly string[];
  readonly submittedAttachmentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
  readonly editableDocumentId?: string;
  readonly continuationPreviousRunId?: string;
  readonly loadedCapabilityIds?: readonly string[];
  readonly savedContinuation?: SavedContinuation;
  readonly signal?: AbortSignal;
  readonly liveEvents?: AgentEventSink;
  readonly setWorkingDocumentGetter: (getter: AgentExecutionHandle["getWorkingDocument"]) => void;
}): Promise<AgentExecutionResult> {
  const transcript = createTranscriptCollector();
  const capabilityTelemetry = createCapabilityTelemetry(input.run.id, input.model.usageAttribution?.model ?? "unknown", input.deps.capabilityEventSink);
  let boundTools: Awaited<ReturnType<typeof createPrimaryDocxTools>>;
  let capabilitySession: ReturnType<typeof createToolSurface>["session"] | undefined;
  let flushAttempted = false;
  let persistenceFailure = false;
  const versionAdvances: DocumentVersionAdvance[] = [];
  const usageAccounting = {
    modelUsage: input.deps.modelUsage,
    managedUsagePolicy: input.deps.managedUsagePolicy,
    attribution: input.model.usageAttribution,
    userId: input.ownerUserId,
    agentRunId: input.run.id,
  };
  let runUsageAttempted = false;
  /** At most once per run on every terminal path, so managed credits are never debited twice. */
  const recordRunUsage = async (usage: ModelCallUsage | undefined, skipEmpty: boolean) => {
    if (runUsageAttempted || !usage) return;
    if (skipEmpty && !usage.inputTokens && !usage.outputTokens && usage.providerReportedCostUsd === undefined) return;
    runUsageAttempted = true;
    await recordModelUsage({ ...usageAccounting, usage });
  };
  const recordFailedRunUsage = (usage: ModelCallUsage | undefined) =>
    recordRunUsage(usage, true).catch((error) =>
      console.warn(`[agent] run=${input.run.id.slice(0, 8)} usage_accounting_failed reason=${summarizeError(error)}`));
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
  // Recovery uses logical-task evidence; billing and telemetry keep physical-run usage.
  const taskMetrics = (metrics: AgentRunMetrics | undefined): AgentRunMetrics | undefined => metrics && input.savedContinuation
    ? { ...metrics, toolCalls: [...input.savedContinuation.toolCalls, ...metrics.toolCalls]
      .map((call, index) => ({ ...call, sequence: index + 1 })) } : metrics;
  try {
    const { checkpoint, priorMessages, historyLoad } = input.savedContinuation
      ? { checkpoint: null, priorMessages: [], historyLoad: {} }
      : await loadHistory({
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

    let savedTarget: { documentId: string; fromVersionId: string; versionId: string } | null = null;
    let createdDocumentId: string | null = input.savedContinuation?.createdDocumentId ?? null;
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
    let brandRead: ReturnType<WorkspaceBrandService['get']> | undefined;
    let includeBrandLogo: boolean | undefined;
    const getBrand = () => brandRead ??= input.deps.workspaceBrand
      ? input.deps.workspaceBrand.get(input.thread.workspaceId, input.ownerUserId)
      : Promise.resolve(null);
    boundTools = await createPrimaryDocxTools({
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      ownerUserId: input.ownerUserId,
      workspaceId: input.thread.workspaceId,
      documentId: input.primaryDocumentId,
      versionId: input.run.baseDocumentVersionId,
      workingDocumentIds: input.workingDocumentIds,
      ...((input.savedContinuation?.editedDocumentId ?? input.editableDocumentId)
        ? { editableDocumentId: input.savedContinuation?.editedDocumentId ?? input.editableDocumentId } : {}),
      ...(input.deps.workspaceAssets ? { workspaceAssets: input.deps.workspaceAssets } : {}),
      ...(input.deps.workspaceBrand ? { getBrandLogoAssetId: async () => (await getBrand())?.logoAssetId ?? null } : {}),
      onDocumentSelected: ({ documentId, versionId }) => {
        input.trace?.write("## Document Target", { documentId, versionId });
        logAgentLine(
          formatDocumentTarget(documentNames.get(documentId) ?? documentId.slice(0, 8)),
        );
        directVersionId = directWorkingVersions.get(documentId) === versionId ? versionId : null;
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
        } else {
          directVersionId = null;
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
    if (input.savedContinuation?.styleState && input.savedContinuation.activeDocumentId === boundTools?.getActiveDocumentId() &&
      input.savedContinuation.savedVersionId === boundTools?.getActiveVersionId()) {
      boundTools.restoreStyleState(input.savedContinuation.styleState);
    }

    const finish = createFinishTool({
      description: "After your concise final response to the user, call this to end the run.",
    });
    const requiresSavedStyle = requestsSavedStyle(input.instruction);
    const attachmentScope = { workspaceId: input.thread.workspaceId, userId: input.ownerUserId, threadId: input.thread.id };
    const attachmentVision = input.deps.attachmentExtraction ? createAttachmentVision({
      service: input.deps.attachmentExtraction, scope: attachmentScope, submittedIds: input.submittedAttachmentIds,
      resolveRoute: input.model.resolveVision, signal: input.signal, savedObservations: input.savedContinuation?.visualObservations,
      beforeReader: async (reader) => {
        if (reader.usageAttribution?.credentialSource === "managed") await input.deps.managedUsagePolicy?.beforeManagedCall(input.ownerUserId);
      },
      recordReader: async (reader, usage) => recordModelUsage({ ...usageAccounting, attribution: reader.usageAttribution, usage }),
    }) : undefined;
    const attachmentEvidence = input.deps.attachmentExtraction
      ? createAttachmentEvidence(input.deps.attachmentExtraction, attachmentScope, input.submittedAttachmentIds, input.instruction)
      : undefined;
    const tools: AgentToolSet = {
      ...(boundTools?.tools ?? {}),
      ...createStandaloneCapabilityTools(),
      ...(input.deps.attachmentExtraction ? createAttachmentTools(input.deps.attachmentExtraction, attachmentScope, attachmentVision?.view) : {}),
      ...(input.deps.workspaceBrand ? createWorkspaceBrandTools({
        getBrand,
        ...(boundTools ? { applyBrand: async (brand, includeLogo) => {
          includeBrandLogo = includeLogo;
          const workspaceLogo = includeLogo && brand.logoAssetId && input.deps.workspaceAssets
            ? await input.deps.workspaceAssets.readBytes(input.thread.workspaceId, input.ownerUserId, brand.logoAssetId)
            : undefined;
          return boundTools!.applyResolvedAppearance(resolveDocumentAppearance({
            workspaceBrand: brand, includeLogo, workspaceLogo,
            policy: { channels: ['typography', 'colors', 'tableAccent', 'logo'] },
            ...(boundTools!.getAppliedStyle() ? { savedStyle: boundTools!.getAppliedStyle()! } : {}),
          }));
        } } : {}),
      }) : {}),
      ...(input.deps.styleProfiles ? createStyleProfileTools({
        profiles: input.deps.styleProfiles, ownerUserId: input.ownerUserId, workspaceId: input.thread.workspaceId,
        ...(boundTools ? { applyProfile: (id: string) => boundTools!.applyStyleProfile(id, input.deps.styleProfiles!) } : {}),
        currentDocument: () => ({ documentId: boundTools?.getActiveDocumentId() ?? null, versionId: boundTools?.getActiveVersionId() ?? null, dirty: (boundTools?.getWorkingMutationCount() ?? 0) > 0 || !!boundTools?.getActiveDraftId() }),
      }) : {}),
      "workspace.search_documents": createWorkspaceSearchTool({
        documents: input.deps.documents,
        ...(input.deps.docxBinding ? { binding: input.deps.docxBinding } : {}),
        ownerUserId: input.ownerUserId,
        workspaceId: input.thread.workspaceId,
      }),
      [finish.name]: requiresSavedStyle ? {
        ...finish.tool,
        execute: async (args, context) => {
          const fidelity = boundTools?.getStyleFidelity();
          if (!fidelity || !boundTools?.getAppliedStyle()) throw new Error('Retrieve and apply the requested saved style with style.apply_profile before finishing. If required information is missing, use finish_with_input_needed and disclose it.');
          if (!fidelity.summary.counts.matched || fidelity.summary.counts.mismatched) throw new Error('Saved style has mismatched fields. Resolve them or finish_with_input_needed and report the unmet style requirement.');
          return finish.tool.execute!(args, context);
        },
      } : finish.tool,
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
    const toolSurface = createToolSurface(tools, capabilityTelemetry.record);
    const readGuard = guardRepeatedReads(toolSurface.tools, () => ({
      documentId: boundTools?.getActiveDocumentId() ?? null,
      versionId: boundTools?.getActiveVersionId() ?? null,
      workingRevision: boundTools?.getWorkingRevision() ?? 0,
      sessionId: input.run.id,
    }));
    capabilitySession = toolSurface.session;
    const recommendations = toolSurface.session.recommend(input.instruction);
    // Recheck each saved ID against this run's tool bindings and request policy.
    for (const id of input.loadedCapabilityIds ?? []) toolSurface.session.load([id], 0);
    const initialTools = toolSurface.session.projectTools();
    const system = (input.savedContinuation?.system ?? buildAgentOperatingInstruction(
      Object.keys(initialTools).map(providerSafeToolName),
      toolSurface.capabilityIndex,
      recommendations,
    ) +
      (requestsDocumentChange(input.instruction)
        ? `\n\n${buildDocumentUpdateInstruction()}`
        : "") +
      (!boundTools?.getActiveDocumentId() && tools["workspace.create_blank_document"]
        ? "\n\nNo document is selected for editing. Create one for a new-document request, or call workspace_select_document with the intended workspace DOCX ID before using document tools."
        : "") +
      (boundTools?.getActiveDocumentId()
        ? `\n\nActive document ID: ${boundTools.getActiveDocumentId()}. Use document tools directly for this target; select another document only to switch targets.`
        : "") +
      "\n\nSearch and inspection do not select a target. Keep edits narrow and preserve unrelated structure and formatting.") +
      (attachmentEvidence && !input.savedContinuation?.system?.includes(ATTACHMENT_SOURCE_POLICY) ? `\n\n${ATTACHMENT_SOURCE_POLICY}` : "");

    const prepared = await prepareContext({
      trace: input.trace,
      checkpoint,
      priorMessages,
      system,
      tools: initialTools,
      instruction: input.instruction,
      activeDocumentId: boundTools?.getActiveDocumentId(),
      activeVersionId: boundTools?.getActiveVersionId(),
      model: input.model,
      runShort,
      cache: input.structureCache,
      binding: input.deps.docxBinding,
      documents: input.deps.documents,
      workspaceDocuments: input.workspaceDocuments,
      ownerUserId: input.ownerUserId,
      workspaceId: input.thread.workspaceId,
      primaryDocumentId: input.primaryDocumentId,
      openDocumentId: input.openDocumentId,
      primaryVersionId: input.run.baseDocumentVersionId,
      submittedDocumentIds: input.submittedDocumentIds,
      workingDocumentIds: input.workingDocumentIds,
    });
    const { workspaceManifest, retrieval, reportRetrieval } = prepared;
    const messages = input.savedContinuation?.messages ?? prepared.messages;
    const context = { ...prepared.context, ...input.savedContinuation?.context };
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
    if (retrieval?.observation.contextStrategy === "direct") {
      directMessage = retrieval.message;
      directWorkingVersions = new Map(retrieval.workingSet.map((document) => [document.documentId, document.versionId]));
      directVersionId = input.run.baseDocumentVersionId;
    }
    if (!input.thread.title?.trim()) {
      const titleStartedAt = Date.now();
      void generateThreadTitle({
        model: input.model.model,
        instruction: input.instruction,
        workingSet: retrieval?.workingSet ?? [],
        documentMaps: retrieval?.documentMaps ?? [],
      })
        .then(async ({ title, usage }) => {
          await recordModelUsage({ ...usageAccounting, usage }).catch((error) =>
            console.warn(`[agent-title] usage accounting failed reason=${summarizeError(error)}`));
          const generated = title !== null && await input.deps.persistence.setThreadTitleIfMissing({ threadId: input.thread.id, title });
          console.debug(`[agent-title] thread=${input.thread.id.slice(0, 8)} generated=${generated} durationMs=${Date.now() - titleStartedAt} model=${input.model.usageAttribution?.model ?? "unknown"}`);
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.debug(`[agent-title] thread=${input.thread.id.slice(0, 8)} generated=false durationMs=${Date.now() - titleStartedAt} model=${input.model.usageAttribution?.model ?? "unknown"} reason=${reason.slice(0, 120)}`);
        });
    }

    const initialMessageCount = input.savedContinuation?.initialMessageCount ?? messages.length;
    let modelTurn = input.savedContinuation?.turns ?? 0;
    let continuation: Record<string, unknown> | undefined;
    const project = composeProjectMessages({
      initialMessageCount,
      retrievalMessage: input.savedContinuation?.retrievalMessage ?? retrieval?.message ?? workspaceManifest,
      ...((input.savedContinuation ? input.savedContinuation.direct : retrieval?.refreshDirectMessage) ? { currentDirectMessage: () => directMessage,
        directVersionId: () => directVersionId,
        currentVersionId: () => directMessage ? boundTools?.getActiveVersionId() ?? null : null,
      } : {}),
      safeToolResultNames: input.model.usageAttribution?.provider === "openrouter",
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
          try {
            const working = boundTools?.getWorkingDocument();
            if (!working) throw new Error("Current working document is unavailable");
            directMessage = await retrieval.refreshDirectMessage({ ...working, name: documentNames.get(working.documentId) ?? working.documentId });
            directSnapshotRevision = workingRevision;
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
      const runtimeState = input.savedContinuation ? [{ role: 'user' as const, content:
        `CONTINUED ENGINE SESSION\nCurrent document ID: ${boundTools?.getActiveDocumentId() ?? 'none'}; current version: ${boundTools?.getActiveVersionId() ?? 'none'}. Earlier opaque handles are stale; inspect again before using handles. Saved version at the boundary: ${input.savedContinuation.savedVersionId ?? 'none'}. Historical tool calls have already executed.` }] : [];
      const baseMessages = [...projected, ...runtimeState, ...(guidance ? [guidance.message] : [])];
      // One byte per token is deliberately more conservative than the general estimator.
      // Optional attachment evidence never trims the instruction or active conversation.
      const remaining = context.safeInputBudgetTokens === undefined ? undefined : Math.max(0,
        context.safeInputBudgetTokens - estimateTokens(system) - estimateTokens(toolContext(currentTools)) - estimateTokens(JSON.stringify(baseMessages)),
      );
      const evidence = await attachmentEvidence?.(remaining);
      const visual = await attachmentVision?.project(baseMessages, remaining === undefined ? undefined : Math.max(0, remaining - Buffer.byteLength(evidence ?? "")));
      const checkedMessages = visual?.checked ?? baseMessages;
      const modelMessages = evidence
        ? [{ role: "user" as const, content: evidence }, ...checkedMessages]
        : checkedMessages;
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
      return [...modelMessages, ...(visual?.messages ?? [])];
    };

    // The one API → agent-core execution call.
    const executeAgent = input.deps.runAgent ?? runAgent;
    const verifySavedDocument = async (metrics?: AgentRunMetrics): Promise<DocumentCheck[]> => {
      if (!savedTarget || !boundTools?.getWorkingMutationCount() || !input.deps.docxBinding) {
        const unrecovered = unrecoveredFailedMutateToolNames(metrics);
        if (!unrecovered.length) return [];
        const checks: DocumentCheck[] = [{
          id: "task",
          status: "fail",
          message: `Could not complete requested update: ${unrecovered.join(", ")}`,
        }];
        transcript.validation(checks);
        input.trace?.write("## Validation", checks);
        logAgentLine(formatValidationChecks(checks));
        return checks;
      }
      const target = savedTarget as { documentId: string; fromVersionId: string; versionId: string };
      try {
        const sources = (retrieval?.workingSet ?? []).filter((item) => item.documentId !== target.documentId);
        const [before, after, ...currentSources] = await Promise.all([
          boundTools?.getBaseDocument()?.documentId === target.documentId && boundTools.getBaseDocument()?.versionId === target.fromVersionId
            ? Promise.resolve(Buffer.from(boundTools.getBaseDocument()!.bytes))
            : input.deps.documents.readExactVersionBytes({ documentId: target.documentId, versionId: target.fromVersionId, ownerUserId: input.ownerUserId }),
          input.deps.documents.readExactVersionBytes({ documentId: target.documentId, versionId: target.versionId, ownerUserId: input.ownerUserId }),
          ...sources.map((item) => input.deps.documents.getOwnedDocument({ documentId: item.documentId, ownerUserId: input.ownerUserId })),
        ]);
        const unrecovered = unrecoveredFailedMutateToolNames(metrics);
        const checks = await verifyDocumentUpdate({
          binding: input.deps.docxBinding,
          before: new Uint8Array(before), after: new Uint8Array(after), instruction: input.instruction,
          successfulMutations: metrics?.toolCalls.filter((tool) => tool.kind === "mutate" && tool.outcome === "success").map((tool) => tool.toolName),
          unrecoveredFailedMutations: unrecovered,
          created: createdDocumentId === target.documentId,
          inputNeeded: isInputNeededTool(metrics?.toolCalls.filter((tool) => tool.outcome === "success" && isFinishTool(tool.toolName)).at(-1)?.toolName),
          targetAdvanced: target.fromVersionId !== target.versionId,
          sourcesUnchanged: input.workingDocumentIds.every((id) => id === target.documentId)
            ? true
            : retrieval && input.workingDocumentIds.every((id) => id === target.documentId || sources.some((source) => source.documentId === id))
              ? sources.every((item, index) => currentSources[index]?.latestVersion.id === item.versionId)
              : null,
        });
        const fidelity = boundTools.getStyleFidelity();
        if (fidelity) {
          const workspaceBrand = fidelity.fields.some((field) => field.source === 'workspace_brand');
          checks.push({ id: 'style', status: fidelity.summary.counts.mismatched ? 'warning' : 'pass', message: `${workspaceBrand ? 'Workspace brand appearance' : 'Appearance'}: ${fidelity.summary.counts.matched} matched, ${fidelity.summary.counts.mismatched} mismatched, ${fidelity.summary.counts.not_applicable} not applicable, ${fidelity.summary.counts.unsupported} unsupported` });
        }
        transcript.validation(checks);
        input.trace?.write("## Validation", checks);
        logAgentLine(formatValidationChecks(checks));
        return checks;
      } catch {
        const checks: DocumentCheck[] = [{ id: "verification", status: "fail", message: "Saved document could not be verified" }];
        input.trace?.write("## Validation", checks);
        transcript.validation(checks);
        logAgentLine(formatValidationChecks(checks));
        return checks;
      }
    };
    let result;
    let verificationChecks: DocumentCheck[] = [];
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
        ...(input.savedContinuation ? { continuation: input.savedContinuation } : {}),
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
      if (isSuccessfulStop(result.stopReason)) {
        await applyAutomaticWorkspaceAppearance({
          deps: input.deps,
          toolSurface,
          boundTools: boundTools!,
          workspaceId: input.thread.workspaceId,
          ownerUserId: input.ownerUserId,
          instruction: input.instruction,
          createdDocumentId,
          getBrand,
          includeLogo: includeBrandLogo,
        });
      }
      const inputNeeded = isInputNeededTool(result.metrics?.toolCalls.filter(tool => tool.outcome === 'success' && isFinishTool(tool.toolName)).at(-1)?.toolName);
      const fidelity = boundTools?.getStyleFidelity();
      if (requiresSavedStyle && isSuccessfulStop(result.stopReason) && !inputNeeded && (!boundTools?.getAppliedStyle() || !fidelity?.summary.counts.matched || fidelity.summary.counts.mismatched)) {
        throw new AgentExecutionError('SAVED_STYLE_NOT_APPLIED', 'The requested saved style was not applied and verified.');
      }
      await flushWorking();
      verificationChecks = await verifySavedDocument(taskMetrics(result.metrics));
    } catch (error) {
      let terminalError = error;
      try { await flushWorking(); } catch (flushError) { terminalError = flushError; }
      verificationChecks = await verifySavedDocument(taskMetrics(result?.metrics ?? getRunMetricsFromError(error)));
      await recordFailedRunUsage((result?.metrics ?? getRunMetricsFromError(error))?.usage);
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

    const unrecoveredMutates = unrecoveredFailedMutateToolNames(taskMetrics(result.metrics));
    const unfinishedWork = unrecoveredMutates.length > 0 || hasBlockingVerificationFailure(verificationChecks);
    const succeeded = isSuccessfulStop(result.stopReason) && !unfinishedWork;
    // Settle usage before the report so a managed-credit failure is reported as the run's real outcome.
    let usageFailure: unknown;
    if (succeeded) {
      try { await recordRunUsage(result, false); } catch (error) { usageFailure = error; }
    } else {
      await recordFailedRunUsage(result.metrics?.usage);
    }

    await emitRunReport({
      trace: input.trace,
      runId: input.run.id,
      instruction: input.instruction,
      model: input.model,
      metrics: result.metrics,
      stopReason: result.stopReason,
      cancelled: false,
      thrown: unfinishedWork || usageFailure !== undefined,
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
      if (result.continuation && !persistenceFailure) {
        transcript.continuation({ version: 1,
          ...(attachmentVision ? { visualObservations: attachmentVision.snapshot() } : {}),
          ...(input.savedContinuation ? { parentRunId: input.continuationPreviousRunId } : {}),
          messages: result.continuation.messages.slice(input.savedContinuation?.messages.length ?? 0),
          turns: result.continuation.turns, failures: result.continuation.failures,
          toolCalls: result.metrics.toolCalls,
          system, initialMessageCount,
          retrievalMessage: input.savedContinuation?.retrievalMessage ?? retrieval?.message ?? workspaceManifest,
          direct: input.savedContinuation?.direct ?? !!retrieval?.refreshDirectMessage,
          context, activeDocumentId: boundTools?.getActiveDocumentId() ?? null,
          savedVersionId: boundTools?.getActiveVersionId() ?? null,
          savedDraftId: boundTools?.getActiveDraftId() ?? null,
          createdDocumentId,
          ...(boundTools ? { styleState: { appliedStyle: boundTools.getAppliedStyle(), styleFidelity: boundTools.getStyleFidelity() } } : {}),
          editedDocumentId: boundTools?.getWorkingMutationCount() ? boundTools.getActiveDocumentId() : input.savedContinuation?.editedDocumentId ?? null,
        } satisfies SavedContinuation);
      }
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
        failureMessage: boundedStopMessage(result.stopReason, versionAdvances.length > 0 || !!input.savedContinuation?.editedDocumentId),
        transcript: transcript.entries(boundTools?.getActiveDocumentId(), [...capabilitySession?.loaded ?? []].sort()),
      });
    }

    if (unfinishedWork) {
      transcript.finish();
      const blocking = verificationChecks.filter((check) => check.status === "fail" && BLOCKING_VERIFICATION_IDS.has(check.id));
      const preserved = versionAdvances.length > 0 || !!input.savedContinuation?.editedDocumentId;
      const unresolved = unrecoveredMutates.length
        ? unrecoveredMutates.join(", ")
        : blocking.map((check) => check.message).join("; ");
      return settleTerminalRunFailure({
        discloseAsAssistant: true,
        cancelled: false,
        persistence: input.deps.persistence,
        ownerUserId: input.ownerUserId,
        thread: input.thread,
        userMessage: input.userMessage,
        run: input.run,
        liveEvents: input.liveEvents,
        failureCode: preserved
          ? unrecoveredMutates.length ? "AGENT_PARTIAL_COMPLETION" : "DOCUMENT_VERIFICATION_FAILED"
          : unrecoveredMutates.length ? "AGENT_MUTATION_FAILED" : "DOCUMENT_VERIFICATION_FAILED",
        failureMessage: preserved
          ? `Updated the document partially. Unresolved: ${unresolved}. Changes made so far were preserved.`
          : `Could not complete the requested update. ${unresolved}`,
        transcript: transcript.entries(boundTools?.getActiveDocumentId(), [...capabilitySession?.loaded ?? []].sort()),
      });
    }

    if (usageFailure !== undefined) throw usageFailure;

    const activeName = documentNames.get(boundTools?.getActiveDocumentId() ?? "") ?? "the document";
    const finalText = result.text.trim() || (versionAdvances.length ? `Saved the changes to ${activeName}.` : "Done.");
    const finalized = await finalizeCompletedRun({
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      threadId: input.thread.id,
      runId: input.run.id,
      content: finalText,
      inputNeeded: result.stopReason === "finish_tool" &&
        isInputNeededTool(result.metrics.toolCalls.filter((call) => call.outcome === "success" && isFinishTool(call.toolName))
          .at(-1)?.toolName),
    });
    transcript.finish(finalText);
    await persistTranscript(input.deps.persistence, input.ownerUserId, input.run.id, transcript.entries(boundTools?.getActiveDocumentId(), [...capabilitySession?.loaded ?? []].sort()));
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
    transcript.clearContinuation();
    let terminalError = error;
    if (!flushAttempted) {
      try { await flushWorking(); } catch (flushError) { terminalError = flushError; }
    }
    await recordFailedRunUsage(getRunMetricsFromError(error)?.usage);
    return settleTerminalRunFailure({
      error: terminalError,
      changesPreserved: versionAdvances.length > 0,
      cancelled: input.signal?.aborted === true && !persistenceFailure,
      persistence: input.deps.persistence,
      ownerUserId: input.ownerUserId,
      thread: input.thread,
      userMessage: input.userMessage,
      run: input.run,
      liveEvents: input.liveEvents,
      transcript: transcript.entries(boundTools?.getActiveDocumentId(), [...capabilitySession?.loaded ?? []].sort()),
    });
  } finally {
    await capabilityTelemetry.flush();
  }
}

/** Reuse only a matching full observation that is still in this run's transcript. */
export function guardRepeatedReads(
  tools: AgentToolSet,
  currentState: () => { documentId: string | null; versionId: string | null; workingRevision: number; sessionId?: string },
) {
  let suppressed = 0;
  const readNames = ["document.inspect", "document.find", "document.style_snapshot"];
  const safeNames = new Set(readNames.map(providerSafeToolName));
  for (const name of readNames) {
    const original = tools[name];
    if (original?.kind !== "read" || !original.execute) continue;
    const execute = original.execute;
    tools[name] = { ...original, execute: async (args, context) => {
      const readState = currentState();
      const stateKey = JSON.stringify(readState);
      const toolName = providerSafeToolName(name);
      const inputKey = JSON.stringify(args);
      // Mutations, document switches, unknown tools, and malformed pairs are barriers.
      const latest = context.messages.at(-1);
      const currentCalls = latest?.role === "assistant" && Array.isArray(latest.content)
        ? latest.content.filter(part => part.type === "tool-call") : [];
      const lastPair = currentCalls.some(call => !safeNames.has(providerSafeToolName(call.toolName)))
        ? -1 : context.messages.length - (latest?.role === "assistant" ? 3 : 2);
      history: for (let index = lastPair; index >= 0 && readState.documentId && readState.versionId; index -= 2) {
        const assistant = context.messages[index];
        const tool = context.messages[index + 1];
        if (assistant?.role !== "assistant" || tool?.role !== "tool" ||
          !Array.isArray(assistant.content) || !Array.isArray(tool.content)) break;
        const calls = assistant.content.filter(part => part.type === "tool-call");
        if (!calls.length || calls.some(call => !safeNames.has(providerSafeToolName(call.toolName)))) break;
        const outputs = tool.content.filter(part => part.type === "tool-result");
        if (new Set(calls.map(call => call.toolCallId)).size !== calls.length || outputs.length !== calls.length ||
          outputs.some(part => !calls.some(call => call.toolCallId === part.toolCallId && providerSafeToolName(call.toolName) === providerSafeToolName(part.toolName)))) break;
        for (const call of calls) {
          if (providerSafeToolName(call.toolName) !== toolName || JSON.stringify(call.input) !== inputKey) continue;
          const results = outputs.filter(part => part.toolCallId === call.toolCallId);
          if (results.length !== 1) break history;
          const part = results[0]!;
          if (part.type !== "tool-result" || providerSafeToolName(part.toolName) !== toolName || part.output.type !== "json") break history;
          const value = part.output.value;
          if (!value || typeof value !== "object" || Array.isArray(value)) break history;
          const result = value as Record<string, unknown>;
          if (JSON.stringify(result.readState) !== stateKey) break history;
          if (result.reusedObservation) continue;
          if (result.ok !== true ||
            (Array.isArray(result.diagnostics) && result.diagnostics.length) ||
            (name === "document.find" && result.matchCount !== 1)) break history;
          suppressed++;
          return { ok: true, reusedObservation: true, readState, originalToolCallId: call.toolCallId,
            message: "Unchanged result: use the full observation from this earlier tool call. No native read executed." };
        }
      }
      const result = await execute(args, context);
      return JSON.stringify(currentState()) === stateKey && result && typeof result === "object" && !Array.isArray(result) && "ok" in result && result.ok === true
        ? { ...result, readState } : result;
    } };
  }
  return { suppressedCount: () => suppressed };
}

export type AgentExecutionService = ReturnType<typeof createAgentExecutionService>;
