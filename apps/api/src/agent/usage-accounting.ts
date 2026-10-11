import type { ManagedUsagePolicy } from "../managed-usage-policy.js";
import type { ModelUsageService } from "../model-usage/service.js";
import type { AgentModelUsageAttribution } from "./execution.js";

export interface ModelCallUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly providerReportedCostUsd?: number;
}

/** Records provider usage, then applies the managed-credit policy (which may throw). */
export async function recordModelUsage(input: {
  readonly modelUsage?: ModelUsageService;
  readonly managedUsagePolicy?: ManagedUsagePolicy;
  readonly attribution?: AgentModelUsageAttribution;
  readonly userId: string;
  readonly agentRunId: string | null;
  readonly usage: ModelCallUsage;
}): Promise<void> {
  if (!input.modelUsage || !input.attribution) return;
  const event = await input.modelUsage.recordFromProviderResponse({
    attribution: { ...input.attribution, userId: input.userId, agentRunId: input.agentRunId },
    usage: {
      inputTokens: input.usage.inputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      outputTokens: input.usage.outputTokens,
      ...(input.usage.reasoningTokens !== undefined ? { reasoningTokens: input.usage.reasoningTokens } : {}),
    },
    ...(input.usage.providerReportedCostUsd !== undefined
      ? { providerReportedCostUsd: input.usage.providerReportedCostUsd }
      : {}),
  });
  if (input.attribution.provider === "openrouter" && input.attribution.credentialSource === "managed") {
    await input.managedUsagePolicy?.afterUsageRecorded(event);
  }
}
