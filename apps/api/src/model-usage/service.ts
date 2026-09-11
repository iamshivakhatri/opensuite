import type { ModelTokenUsage } from "@opensuite/agent-core";

import {
  estimateModelCost,
  productionModelPricingRegistry,
  type ModelPricingRegistry,
} from "./pricing.js";
import type { ModelUsageRepository } from "./repository.js";
import type {
  ModelUsageAggregate,
  ModelUsageAttribution,
  ModelUsageCostAggregate,
  ModelUsageCostSnapshot,
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

export function costSnapshotFromEstimate(
  provider: ModelUsageAttribution["provider"],
  model: string,
  tokens: ModelUsageTokens,
  pricing: ModelPricingRegistry,
): ModelUsageCostSnapshot {
  const estimated = estimateModelCost({
    provider,
    model,
    tokens,
    pricing: pricing.lookup(provider, model),
  });
  if (estimated.status !== "priced") {
    return {
      estimatedCostMicros: null,
      costCurrency: null,
      pricingVersion: null,
    };
  }
  return {
    estimatedCostMicros: estimated.estimatedCostMicros,
    costCurrency: estimated.currency,
    pricingVersion: estimated.pricingVersion,
  };
}

export interface ModelUsageServiceOptions {
  readonly pricing?: ModelPricingRegistry;
  /** Optional hook when cost estimation fails unexpectedly. */
  readonly onPricingError?: (error: unknown) => void;
}

export function createModelUsageService(
  repository: ModelUsageRepository,
  options: ModelUsageServiceOptions = {},
) {
  const pricing = options.pricing ?? productionModelPricingRegistry;

  return {
    async record(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
      return repository.insert(input);
    },

    /**
     * Record one completed provider request using trusted attribution +
     * provider-reported usage from ModelResponse.meta.
     * Attaches an immutable cost snapshot when exact-model pricing is known.
     */
    async recordFromProviderResponse(input: {
      attribution: ModelUsageAttribution;
      usage: ModelTokenUsage | undefined;
    }): Promise<ModelUsageEvent> {
      const tokens = normalizeModelUsageTokens(input.usage);
      let cost: ModelUsageCostSnapshot;
      try {
        cost = costSnapshotFromEstimate(
          input.attribution.provider,
          input.attribution.model,
          tokens,
          pricing,
        );
      } catch (error) {
        options.onPricingError?.(error);
        cost = {
          estimatedCostMicros: null,
          costCurrency: null,
          pricingVersion: null,
        };
      }
      return repository.insert({
        ...input.attribution,
        tokens,
        cost,
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

    async aggregateEstimatedCostForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
      credentialSource?: ModelUsageEvent["credentialSource"];
    }): Promise<ModelUsageCostAggregate> {
      return repository.aggregateEstimatedCostForUser(input);
    },
  };
}

export type ModelUsageService = ReturnType<typeof createModelUsageService>;
