import type { ModelTokenUsage } from "@opensuite/agent-core";

import {
  OPENROUTER_USAGE_COST_SOURCE,
  usdToCostMicros,
} from "../openrouter-models/cost.js";
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
      costMicros: null,
      costCurrency: null,
      costSource: null,
    };
  }
  return {
    costMicros: estimated.estimatedCostMicros,
    costCurrency: estimated.currency,
    costSource: estimated.pricingVersion,
  };
}

/**
 * Prefer OpenRouter provider-reported usage.cost; otherwise fall back to the
 * optional static registry (tests / future). Never invent zero from absence.
 */
export function resolveCostSnapshot(input: {
  readonly provider: ModelUsageAttribution["provider"];
  readonly model: string;
  readonly tokens: ModelUsageTokens;
  readonly providerReportedCostUsd?: string | number;
  readonly pricing: ModelPricingRegistry;
}): ModelUsageCostSnapshot {
  if (
    input.provider === "openrouter" &&
    input.providerReportedCostUsd !== undefined
  ) {
    const costMicros = usdToCostMicros(input.providerReportedCostUsd);
    if (costMicros !== null) {
      return {
        costMicros,
        costCurrency: "USD",
        costSource: OPENROUTER_USAGE_COST_SOURCE,
      };
    }
    // Present but unparseable → leave null rather than falling back to catalog.
    return {
      costMicros: null,
      costCurrency: null,
      costSource: null,
    };
  }

  return costSnapshotFromEstimate(
    input.provider,
    input.model,
    input.tokens,
    input.pricing,
  );
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
     * OpenRouter: prefer usage.cost → micro-USD snapshot.
     * Other providers: optional static registry estimate (may stay null).
     */
    async recordFromProviderResponse(input: {
      attribution: ModelUsageAttribution;
      usage: ModelTokenUsage | undefined;
      providerReportedCostUsd?: string | number;
    }): Promise<ModelUsageEvent> {
      const tokens = normalizeModelUsageTokens(input.usage);
      let cost: ModelUsageCostSnapshot;
      try {
        cost = resolveCostSnapshot({
          provider: input.attribution.provider,
          model: input.attribution.model,
          tokens,
          providerReportedCostUsd: input.providerReportedCostUsd,
          pricing,
        });
      } catch (error) {
        options.onPricingError?.(error);
        cost = {
          costMicros: null,
          costCurrency: null,
          costSource: null,
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

    async aggregateCostForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
      credentialSource?: ModelUsageEvent["credentialSource"];
    }): Promise<ModelUsageCostAggregate> {
      return repository.aggregateCostForUser(input);
    },
  };
}

export type ModelUsageService = ReturnType<typeof createModelUsageService>;
