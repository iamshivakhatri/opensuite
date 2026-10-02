import type { AgentToolSet, ModelMessage } from "@opensuite/agent-core-v3";
import type { DocxEngineBinding } from "@opensuite/engine-client";

import type { DocumentService } from "../documents/service.js";
import { formatWorkspaceManifest } from "./workspace-manifest.js";
import type { AgentRunReportRetrieval } from "./agent-run-report.js";
import {
  estimateTokens,
  availableEvidenceTokenBudget,
  computeInputBudget,
  MAX_HISTORY_MESSAGES,
  projectHistoricalMessages,
  truncateToTokenBudget,
  type HistoricalMessage,
} from "./context-projection.js";
import {
  retrieveWorkspaceContext,
  SlimDocumentStructureCache,
  formatDocumentMap,
  type DocumentMap,
  type WorkspaceArtifact,
  type WorkspaceRetrieval,
} from "./document-retrieval.js";
import type {
  AgentPersistenceService,
  AgentThreadContextCheckpoint,
} from "./persistence.js";
import { isFinishTool, summarizeError } from "./run-events.js";
import type { RunTrace } from "./run-trace.js";

export type PreparedContext = {
  readonly messages: ModelMessage[];
  readonly workspaceManifest: string;
  readonly context: {
    readonly checkpointUsed: boolean;
    readonly historyQueryMode: "recent" | "post_checkpoint";
    readonly checkpointThroughMessageId?: string;
    readonly historicalMessagesAfterCheckpoint: number;
    readonly historicalMessagesLoaded: number;
    readonly historicalMessagesProjected: number;
    readonly historicalCharactersLoaded: number;
    readonly historicalCharactersProjected: number;
    readonly estimatedHistoricalTokens: number;
    readonly historyWasTrimmed: boolean;
    readonly historyTrimmedByTokenBudget: boolean;
    readonly modelContextLength?: number;
    readonly outputReserveTokens?: number;
    readonly continuationReserveTokens?: number;
    readonly safetyMarginTokens?: number;
    readonly safeInputBudgetTokens?: number;
    readonly estimatedInputTokens: number;
    readonly approximateTokenBudgetApplied: boolean;
  };
  readonly retrieval: RetrievedContext | undefined;
  readonly reportRetrieval: AgentRunReportRetrieval | undefined;
};

export type RetrievedContext = {
  readonly message?: string;
  readonly refreshDirectMessage?: WorkspaceRetrieval["refreshDirectMessage"];
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
};

export async function loadHistory(input: {
  readonly persistence: AgentPersistenceService;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly excludeMessageId: string;
}): Promise<{
  readonly checkpoint: AgentThreadContextCheckpoint | null;
  readonly priorMessages: readonly HistoricalMessage[];
  readonly historyLoad: { completedHumanTurnsLoaded: number; userMessagesLoaded: number;
    assistantFinalMessagesLoaded: number; compactRunSummariesLoaded: number; orphanHistoricalMessagesOmitted: number };
}> {
  const checkpoint = await input.persistence.getLatestThreadContextCheckpoint({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
  });
  const recent = await input.persistence.listRecentMessagesForContext({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    checkpoint,
    excludeMessageId: input.excludeMessageId,
    limit: MAX_HISTORY_MESSAGES,
  });
  const users = recent.filter((message) => message.role === "user");
  const runs = await input.persistence.listRunsForTriggerMessages({
    threadId: input.threadId, ownerUserId: input.ownerUserId,
    messageIds: users.map((message) => message.id),
  });
  const terminal = new Set(["completed", "completed_with_input_needed", "failed", "cancelled"]);
  const runByUser = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (run.triggeringMessageId && terminal.has(run.status) && !runByUser.has(run.triggeringMessageId)) {
    runByUser.set(run.triggeringMessageId, run);
  }
  const messagesById = new Map(recent.map((message) => [message.id, message]));
  const missingResults = await Promise.all([...runByUser.values()]
    .filter((run) => run.resultMessageId && !messagesById.has(run.resultMessageId))
    .map((run) => input.persistence.getMessageForThread({
        threadId: input.threadId, ownerUserId: input.ownerUserId, messageId: run.resultMessageId!,
      })));
  for (const result of missingResults) if (result) messagesById.set(result.id, result);
  const toolRows = await input.persistence.listToolNamesForRuns({
    threadId: input.threadId, ownerUserId: input.ownerUserId,
    runIds: [...runByUser.values()].map((run) => run.id),
  });
  const toolNames = new Map<string, Set<string>>();
  for (const row of toolRows) {
    if (isFinishTool(row.name)) continue;
    if (!toolNames.has(row.runId)) toolNames.set(row.runId, new Set());
    toolNames.get(row.runId)!.add(row.name);
  }
  const priorMessages: HistoricalMessage[] = [];
  const used = new Set<string>();
  let completedHumanTurnsLoaded = 0;
  let assistantFinalMessagesLoaded = 0;
  let compactRunSummariesLoaded = 0;
  for (const user of users) {
    const run = runByUser.get(user.id);
    const following = recent[recent.indexOf(user) + 1];
    const linked = run?.resultMessageId ? messagesById.get(run.resultMessageId) : undefined;
    const assistant = linked?.role === "assistant" ? linked : following?.role === "assistant" ? following : undefined;
    if (!run && !assistant) continue;
    completedHumanTurnsLoaded++;
    used.add(user.id);
    if (assistant) used.add(assistant.id);
    const status = run?.status === "completed_with_input_needed" ? "needs_input" : run?.status;
    const names = run ? [...(toolNames.get(run.id) ?? [])] : [];
    const summary = run ? ["RUN RESULT", `status: ${status}`,
      `tools used: ${names.length ? names.join(", ") : "none"}`,
      ...(!assistant && run.status === "failed" ? [`reason: ${(run.errorMessage ?? run.errorCode ?? "Run failed").slice(0, 200)}`] : []),
    ].join("\n") : "";
    if (summary) compactRunSummariesLoaded++;
    priorMessages.push({ role: "user", content: assistant ? user.content : `${summary}\n\nUSER REQUEST\n${user.content}` });
    if (assistant) {
      assistantFinalMessagesLoaded++;
      priorMessages.push({ role: "assistant", content: summary ? `${summary}\n\n${assistant.content}` : assistant.content });
    }
  }
  return { checkpoint, priorMessages, historyLoad: { completedHumanTurnsLoaded,
    userMessagesLoaded: completedHumanTurnsLoaded, assistantFinalMessagesLoaded,
    compactRunSummariesLoaded, orphanHistoricalMessagesOmitted: recent.filter((message) => !used.has(message.id)).length } };
}

/**
 * Budget history, retrieve evidence, and assemble the first-turn model messages.
 * Call after tools/system exist so required token reserves include tool schemas.
 */
export async function prepareContext(input: {
  readonly trace?: RunTrace;
  readonly checkpoint: AgentThreadContextCheckpoint | null;
  readonly priorMessages: readonly HistoricalMessage[];
  readonly system: string;
  readonly tools: AgentToolSet;
  readonly instruction: string;
  readonly continuationContext?: string;
  readonly activeDocumentId: string | null | undefined;
  readonly activeVersionId: string | null | undefined;
  readonly model: {
    readonly contextLength?: number;
    readonly maxOutputTokens?: number;
    readonly outputTokenLimit?: number;
    readonly usageAttribution?: { readonly model?: string };
  };
  readonly runShort: string;
  readonly cache: SlimDocumentStructureCache;
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: Pick<DocumentService, "listInWorkspace" | "readExactVersionBytes">;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly primaryDocumentId: string | null;
  readonly openDocumentId: string | null;
  readonly primaryVersionId: string | null;
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
}): Promise<PreparedContext> {
  const historicalMessages = input.priorMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  let workspaceDocuments: Awaited<ReturnType<typeof input.documents.listInWorkspace>> | undefined;
  try {
    workspaceDocuments = await input.documents.listInWorkspace(input.workspaceId, input.ownerUserId);
  } catch (error) {
    input.trace?.write("## Workspace Manifest — Error", error);
    console.warn(`[agent-v3] workspace_manifest_unavailable reason=${summarizeError(error)}`);
  }
  const workspaceManifest = workspaceDocuments
    ? formatWorkspaceManifest(workspaceDocuments.map((document) => ({
        documentId: document.id, name: document.name, format: document.format,
        updatedAt: document.updatedAt, latestVersionNumber: document.latestVersion.versionNumber,
      })), input.openDocumentId, input.submittedDocumentIds)
    : "WORKSPACE MANIFEST\nUnavailable; use workspace_search_documents to retry.";
  const requiredTokens =
    estimateTokens(input.system) +
    estimateTokens(toolContext(input.tools)) +
    estimateTokens(input.instruction) +
    estimateTokens(input.continuationContext ?? "") +
    estimateTokens(workspaceManifest);
  const budget =
    input.model.contextLength !== undefined
      ? computeInputBudget({
          contextLength: input.model.contextLength,
          maxOutputTokens: input.model.outputTokenLimit ?? input.model.maxOutputTokens,
        })
      : undefined;
  if (budget?.usedOutputReserveFallback) {
    console.info(
      `[agent] output_reserve_fallback run=${input.runShort} tokens=${budget.outputReserve} model=${input.model.usageAttribution?.model ?? "unknown"}`,
    );
  }
  const inputBudget = budget?.safeInputBudget;
  const checkpointContent = input.checkpoint
    ? checkpointMessageContent(input.checkpoint)
    : "";
  const checkpointBudget = inputBudget === undefined
    ? undefined
    : Math.max(0, inputBudget - requiredTokens);
  const projectedCheckpoint = input.checkpoint
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
    input.model.outputTokenLimit ?? input.model.maxOutputTokens,
  );
  const retrieval = await loadRetrievedContext({
    trace: input.trace,
    cache: input.cache,
    binding: input.binding,
    documents: input.documents,
    workspaceDocuments,
    ownerUserId: input.ownerUserId,
    instruction: input.instruction,
    workspaceId: input.workspaceId,
    primaryDocumentId: input.primaryDocumentId,
    openDocumentId: input.openDocumentId,
    primaryVersionId: input.primaryVersionId,
    submittedDocumentIds: input.submittedDocumentIds,
    workingDocumentIds: input.workingDocumentIds,
    availableEvidenceTokens: planningAvailableEvidenceTokens,
  });
  const evidenceTokens = Math.max(0, estimateTokens(retrieval?.message ?? "") - estimateTokens(workspaceManifest));
  const finalCheckpointBudget = inputBudget === undefined
    ? undefined
    : Math.max(0, inputBudget - requiredTokens - evidenceTokens);
  const finalProjectedCheckpoint = input.checkpoint
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
    input.model.outputTokenLimit ?? input.model.maxOutputTokens,
  );
  const context = {
    ...finalHistoricalContext,
    checkpointUsed: input.checkpoint !== null,
    historyQueryMode: input.checkpoint ? "post_checkpoint" as const : "recent" as const,
    ...(input.checkpoint
      ? { checkpointThroughMessageId: input.checkpoint.throughMessageId }
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
      ? [{ role: "user" as const, content: `${input.continuationContext}\nCurrent document ID: ${input.activeDocumentId ?? "none"}; current version: ${input.activeVersionId ?? "none"}.` }]
      : []),
    { role: "user", content: input.instruction },
  ];
  return { messages, workspaceManifest, context, retrieval, reportRetrieval };
}

function toolContext(tools: AgentToolSet): string {
  return Object.entries(tools)
    .map(([name, tool]) => `${name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
}

async function loadRetrievedContext(input: {
  readonly trace?: RunTrace;
  readonly cache: SlimDocumentStructureCache;
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: Pick<DocumentService, "listInWorkspace" | "readExactVersionBytes">;
  readonly workspaceDocuments: Awaited<ReturnType<DocumentService["listInWorkspace"]>> | undefined;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly workspaceId: string;
  readonly primaryDocumentId: string | null;
  readonly openDocumentId: string | null;
  readonly primaryVersionId: string | null;
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
  readonly availableEvidenceTokens?: number;
}): Promise<RetrievedContext | undefined> {
  if (!input.binding || !input.workspaceDocuments) return undefined;
  const startedAt = Date.now();
  try {
    const documents = input.workspaceDocuments;
    input.trace?.write("## Retrieval — Artifact Metadata", documents.map((document) => ({
      documentId: document.id, versionId: document.id === input.primaryDocumentId && input.primaryVersionId ? input.primaryVersionId : document.latestVersion.id,
      name: document.name, format: document.format,
    })));
    const retrieved = await retrieveWorkspaceContext({
      artifacts: documents.map((document) => ({
        documentId: document.id,
        versionId: document.id === input.primaryDocumentId && input.primaryVersionId
          ? input.primaryVersionId
          : document.latestVersion.id,
        name: document.name,
        format: document.format,
        updatedAt: document.updatedAt,
        latestVersionNumber: document.latestVersion.versionNumber,
      })),
      instruction: input.instruction,
      primaryDocumentId: input.primaryDocumentId,
      openDocumentId: input.openDocumentId,
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
    input.trace?.write("## Retrieval — Document Evidence / Injected Context", retrieved);
    return {
      ...(message ? { message } : {}),
      ...(retrieved.refreshDirectMessage ? { refreshDirectMessage: retrieved.refreshDirectMessage } : {}),
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
    input.trace?.write("## Retrieval — Error", error);
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
 * Compose first-turn retrieval with the current DIRECT view.
 * Retrieval injects once, or DIRECT supplies the current view every turn.
 * Keep the same-run assistant/tool exchange intact for provider continuation.
 */
export function composeProjectMessages(input: {
  readonly retrievalMessage?: string;
  readonly currentDirectMessage?: () => string | undefined;
  readonly safeToolResultNames?: boolean;
  readonly directVersionId?: string | null | (() => string | null);
  readonly currentVersionId?: () => string | null;
  readonly suppressedReadCount?: () => number;
}): (messages: readonly ModelMessage[]) => readonly ModelMessage[] {
  const firstTurn = input.retrievalMessage
    ? firstTurnContextProjection(input.retrievalMessage)
    : (messages: readonly ModelMessage[]) => messages;
  let projectedOnce = false;
  let directPosition = 0;

  return (messages) => {
    const first = !projectedOnce;
    if (first) directPosition = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
    projectedOnce = true;
    const currentVersion = input.currentVersionId?.();
    const directVersionId = typeof input.directVersionId === "function" ? input.directVersionId() : input.directVersionId;
    const directCurrent = directVersionId && currentVersion === directVersionId;
    let afterFirstTurn = !first && directCurrent && input.retrievalMessage
      ? [...messages, { role: "user" as const, content: input.retrievalMessage }]
      : firstTurn(messages);
    if (input.currentDirectMessage) {
      const current = input.currentDirectMessage();
      afterFirstTurn = directCurrent && current
        ? [...messages.slice(0, directPosition), { role: "user" as const, content: current }, ...messages.slice(directPosition)]
        : afterFirstTurn;
    }
    const withReadReminder = directCurrent && input.suppressedReadCount?.()
      ? [...afterFirstTurn, { role: "user" as const, content: "The complete unchanged document is already above. Repeated reads were skipped. Stop inspecting and perform the requested document changes using the available mutation tools." }]
      : afterFirstTurn;
    if (!input.safeToolResultNames) return withReadReminder;
    return withReadReminder.map((message) => {
      if (!Array.isArray(message.content)) return message;
      if (message.role !== "tool" && message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool-result" || part.type === "tool-call"
            ? { ...part, toolName: part.toolName.replace(/[^a-zA-Z0-9_-]/g, "_") }
            : part,
        ),
      } as ModelMessage;
    });
  };
}

/** AI SDK has no application-context role; label this API-owned user message. */
function checkpointMessageContent(checkpoint: AgentThreadContextCheckpoint): string {
  return `Historical conversation checkpoint through ${checkpoint.throughMessageId}:\n${checkpoint.content}`;
}
