import type { ModelTokenUsage } from "@opensuite/agent-core";

import type { ModelUsageRepository } from "./repository.js";
import type {
  ModelUsageAggregate,
  ModelUsageAttribution,
  ModelUsageEvent,
  ModelUsageTokens,
  RecordModelUsageInput,
} from "./types.js";

/**
 * Normalize provider-neutral adapter usage into ledger token fields.
 * Missing fields stay null — never invent zero.
 */
export function normalizeModelUsageTokens(
  usage: ModelTokenUsage | undefined,
): ModelUsageTokens {
  return {
    inputTokens:
      typeof usage?.inputTokens === "number" ? usage.inputTokens : null,
    outputTokens:
      typeof usage?.outputTokens === "number" ? usage.outputTokens : null,
    cachedInputTokens:
      typeof usage?.cachedInputTokens === "number"
        ? usage.cachedInputTokens
        : null,
    reasoningTokens:
      typeof usage?.reasoningTokens === "number"
        ? usage.reasoningTokens
        : null,
  };
}

export function createModelUsageService(repository: ModelUsageRepository) {
  return {
    async record(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
      return repository.insert(input);
    },

    /**
     * Record one completed provider request using trusted attribution +
     * provider-reported usage from ModelResponse.meta.
     */
    async recordFromProviderResponse(input: {
      attribution: ModelUsageAttribution;
      usage: ModelTokenUsage | undefined;
    }): Promise<ModelUsageEvent> {
      return repository.insert({
        ...input.attribution,
        tokens: normalizeModelUsageTokens(input.usage),
      });
    },

    async listForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
      limit?: number;
    }): Promise<ModelUsageEvent[]> {
      return repository.listForUser(input);
    },

    async aggregateForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
    }): Promise<ModelUsageAggregate> {
      return repository.aggregateForUser(input);
    },
  };
}

export type ModelUsageService = ReturnType<typeof createModelUsageService>;
