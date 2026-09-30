import type { AgentToolSet, ModelMessage } from "@opensuite/agent-core-v3";
import type { DocxEngineBinding } from "@opensuite/engine-client";

import type { DocumentService } from "../documents/service.js";
import type { AgentRunReportRetrieval } from "./agent-run-report.js";
import {
  estimateTokens,
  availableEvidenceTokenBudget,
  computeInputBudget,
  MAX_HISTORY_MESSAGES,
  projectHistoricalMessages,
  truncateToTokenBudget,
} from "./context-projection.js";
import {
  retrieveWorkspaceContext,
  SlimDocumentStructureCache,
  formatDocumentMap,
  type DocumentMap,
  type WorkspaceArtifact,
} from "./document-retrieval.js";
import {
  accumulateInRunObservationStats,
  createInRunObservationStats,
  projectInRunObservations,
} from "./in-run-observation-projection.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentThreadContextCheckpoint,
} from "./persistence.js";

export type PreparedContext = {
  readonly messages: ModelMessage[];
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
  readonly priorMessages: readonly AgentMessage[];
}> {
  const checkpoint = await input.persistence.getLatestThreadContextCheckpoint({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
  });
  const priorMessages = await input.persistence.listRecentMessagesForContext({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    checkpoint,
    excludeMessageId: input.excludeMessageId,
    limit: MAX_HISTORY_MESSAGES,
  });
  return { checkpoint, priorMessages };
}

/**
 * Budget history, retrieve evidence, and assemble the first-turn model messages.
 * Call after tools/system exist so required token reserves include tool schemas.
 */
export async function prepareContext(input: {
  readonly checkpoint: AgentThreadContextCheckpoint | null;
  readonly priorMessages: readonly AgentMessage[];
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
  readonly primaryVersionId: string | null;
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
}): Promise<PreparedContext> {
  const historicalMessages = input.priorMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const requiredTokens =
    estimateTokens(input.system) +
    estimateTokens(toolContext(input.tools)) +
    estimateTokens(input.instruction) +
    estimateTokens(input.continuationContext ?? "");
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
    cache: input.cache,
    binding: input.binding,
    documents: input.documents,
    ownerUserId: input.ownerUserId,
    instruction: input.instruction,
    workspaceId: input.workspaceId,
    primaryDocumentId: input.primaryDocumentId,
    primaryVersionId: input.primaryVersionId,
    submittedDocumentIds: input.submittedDocumentIds,
    workingDocumentIds: input.workingDocumentIds,
    availableEvidenceTokens: planningAvailableEvidenceTokens,
  });
  const evidenceTokens = estimateTokens(retrieval?.message ?? "");
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
  return { messages, context, retrieval, reportRetrieval };
}

function toolContext(tools: AgentToolSet): string {
  return Object.entries(tools)
    .map(([name, tool]) => `${name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
}

async function loadRetrievedContext(input: {
  readonly cache: SlimDocumentStructureCache;
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: Pick<DocumentService, "listInWorkspace" | "readExactVersionBytes">;
  readonly ownerUserId: string;
  readonly instruction: string;
  readonly workspaceId: string;
  readonly primaryDocumentId: string | null;
  readonly primaryVersionId: string | null;
  readonly submittedDocumentIds: readonly string[];
  readonly workingDocumentIds: readonly string[];
  readonly availableEvidenceTokens?: number;
}): Promise<RetrievedContext | undefined> {
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
    const reason =
      error instanceof Error
        ? `${error.name || "Error"}: ${error.message}`.slice(0, 400)
        : String(error).slice(0, 400);
    console.warn(`[agent-v3] workspace_retrieval_skipped reason=${reason}`);
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
