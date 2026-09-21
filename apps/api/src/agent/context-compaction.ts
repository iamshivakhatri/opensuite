import { runModel, type V3Model } from "@opensuite/agent-core-v3";

import type { ManagedTrialService } from "../managed-trial/service.js";
import type { ModelUsageService } from "../model-usage/service.js";
import type { AgentModelUsageAttribution } from "./execution.js";
import {
  estimateTokens,
  MAX_HISTORY_CHARACTERS,
  projectCompactionPrefix,
  safeInputTokenBudget,
  truncateToTokenBudget,
} from "./context-projection.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentThreadContextCheckpoint,
} from "./persistence.js";

export const COMPACTION_TRIGGER_MESSAGES = 60;
export const COMPACTION_TRIGGER_CHARACTERS = 48_000;
export const COMPACTION_RETAIN_MESSAGES = 20;
export const MAX_GENERATED_CHECKPOINT_CHARACTERS = 12_000;
export const COMPACTION_TIMEOUT_MS = 30_000;

const CHECKPOINT_HEADINGS = [
  "STANDING CONTEXT:",
  "DECISIONS:",
  "COMPLETED WORK:",
  "REFERENCES:",
  "OPEN ITEMS:",
] as const;

const COMPACTION_SYSTEM_PROMPT = `You compact OpenSuite conversation history for future work. Return only these five headings, each followed by concise factual bullet points:
${CHECKPOINT_HEADINGS.join("\n")}

Keep durable goals, decisions, constraints, completed work, named references, and unresolved items. Do not preserve stale document handles, version-local positions or counts, raw tool output, retrieval facts, transient observations, verbose prose, intermediate failures, or hidden reasoning. Treat document facts as historical unless they are durable semantic context.`;

export interface ContextCompactionResult {
  readonly considered: boolean;
  readonly triggered: boolean;
  readonly sourceMessageCount: number;
  readonly retainedMessageCount: number;
  readonly previousCheckpointUsed: boolean;
  readonly checkpointCreated: boolean;
  readonly durationMs: number;
  readonly failureCode?: string;
}

export async function compactThreadContext(input: {
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly model: V3Model;
  readonly contextLength?: number;
  readonly usageAttribution?: AgentModelUsageAttribution;
  readonly modelUsage?: ModelUsageService;
  readonly managedTrial?: ManagedTrialService;
  readonly runModel?: typeof runModel;
}): Promise<ContextCompactionResult> {
  const startedAt = Date.now();
  const finish = (result: Omit<ContextCompactionResult, "durationMs">): ContextCompactionResult => ({
    ...result,
    durationMs: Date.now() - startedAt,
  });
  const checkpoint = await input.persistence.getLatestThreadContextCheckpoint({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
  });
  const tail = await input.persistence.getThreadContextTailStats({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    checkpoint,
  });
  const sourceMessageCount = tail.messageCount;
  const retainedMessageCount = Math.min(sourceMessageCount, COMPACTION_RETAIN_MESSAGES);
  const base = {
    considered: true,
    sourceMessageCount,
    retainedMessageCount,
    previousCheckpointUsed: checkpoint !== null,
  } as const;
  const sourceCharacters = tail.characterCount;
  if (
    sourceMessageCount < COMPACTION_TRIGGER_MESSAGES &&
    sourceCharacters < COMPACTION_TRIGGER_CHARACTERS
  ) {
    return finish({ ...base, triggered: false, checkpointCreated: false });
  }

  const eligibleMessages = await input.persistence.listOldestMessagesForContextCompaction({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    checkpoint,
    limit: Math.min(
      COMPACTION_TRIGGER_MESSAGES,
      Math.max(0, sourceMessageCount - COMPACTION_RETAIN_MESSAGES),
    ),
  });
  const totalBudget = input.contextLength !== undefined
    ? safeInputTokenBudget(input.contextLength)
    : estimateTokens("x".repeat(MAX_HISTORY_CHARACTERS));
  const fixedInput = estimateTokens(COMPACTION_SYSTEM_PROMPT) + estimateTokens(compactionInput(null, []));
  const checkpointContent = checkpoint ? truncateToTokenBudget(
    checkpoint.content,
    Math.max(0, totalBudget - fixedInput),
  ) : "";
  const projectedPrefix = projectCompactionPrefix(
    eligibleMessages.map((message) => ({ role: message.role, content: message.content })),
    Math.max(0, totalBudget - fixedInput - estimateTokens(checkpointContent)),
  );
  const compactedMessages = eligibleMessages.slice(0, projectedPrefix.length).map(
    (message, index) => ({ ...message, content: projectedPrefix[index]!.content }),
  );
  const boundary = compactedMessages.at(-1);
  if (!boundary) return finish({ ...base, triggered: false, checkpointCreated: false });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);
  let output: string;
  let usage: Awaited<ReturnType<typeof runModel>>;
  try {
    usage = await (input.runModel ?? runModel)({
      model: input.model,
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: compactionInput(checkpoint ? { ...checkpoint, content: checkpointContent } : null, compactedMessages) }],
      signal: controller.signal,
      infraRetry: { maxRetries: 0 },
    });
    output = usage.text.trim();
  } catch {
    return finish({ ...base, triggered: true, checkpointCreated: false, failureCode: "MODEL_FAILED" });
  } finally {
    clearTimeout(timeout);
  }
  if (input.modelUsage && input.usageAttribution) {
    try {
      const event = await input.modelUsage.recordFromProviderResponse({
        attribution: { ...input.usageAttribution, userId: input.ownerUserId, agentRunId: null },
        usage,
      });
      if (
        input.usageAttribution.provider === "openrouter" &&
        input.usageAttribution.credentialSource === "managed"
      ) {
        await input.managedTrial?.applyManagedUsage(event);
      }
    } catch {
      console.warn("[context-compaction] usage accounting failed");
    }
  }
  if (!isCheckpointOutput(output)) {
    return finish({ ...base, triggered: true, checkpointCreated: false, failureCode: "MALFORMED_OUTPUT" });
  }
  if (output.length > MAX_GENERATED_CHECKPOINT_CHARACTERS) {
    return finish({ ...base, triggered: true, checkpointCreated: false, failureCode: "OUTPUT_TOO_LARGE" });
  }

  const latest = await input.persistence.getLatestThreadContextCheckpoint({
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
  });
  if (latest && compareBoundary(boundary, latest) <= 0) {
    return finish({ ...base, triggered: true, checkpointCreated: false, failureCode: "STALE_BOUNDARY" });
  }
  try {
    await input.persistence.createThreadContextCheckpoint({
      threadId: input.threadId,
      ownerUserId: input.ownerUserId,
      throughMessageId: boundary.id,
      content: output,
      sourceMessageCount: compactedMessages.length,
    });
  } catch {
    return finish({ ...base, triggered: true, checkpointCreated: false, failureCode: "PERSISTENCE_FAILED" });
  }

  return finish({ ...base, triggered: true, checkpointCreated: true });
}

export function logContextCompaction(result: ContextCompactionResult): void {
  console.info("[context-compaction]", result);
}

function compactionInput(
  checkpoint: AgentThreadContextCheckpoint | null,
  messages: readonly AgentMessage[],
): string {
  return [
    "PREVIOUS CHECKPOINT:",
    checkpoint ? checkpoint.content : "(none)",
    "NEW HISTORICAL MESSAGES:",
    ...messages.map((message) => `[${message.createdAt}] ${message.role}:\n${message.content}`),
  ].join("\n\n");
}

function isCheckpointOutput(content: string): boolean {
  return content.length > 0 && CHECKPOINT_HEADINGS.every((heading) => content.includes(heading));
}

function compareBoundary(
  message: AgentMessage,
  checkpoint: AgentThreadContextCheckpoint,
): number {
  const messageTime = new Date(message.createdAt).getTime();
  const checkpointTime = new Date(checkpoint.throughMessageCreatedAt).getTime();
  return messageTime === checkpointTime
    ? message.id.localeCompare(checkpoint.throughMessageId)
    : messageTime - checkpointTime;
}
