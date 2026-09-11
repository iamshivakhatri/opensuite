import type { ProviderCredentialProvider } from "../credentials/types.js";

import type { ModelUsageTokens } from "./types.js";

/** 1 USD = 1_000_000 micro-USD. Persisted costs use this integer unit. */
export const MICRO_USD_PER_USD = 1_000_000;

/**
 * How cached input tokens relate to `inputTokens` for billing.
 *
 * - anthropic_separate: `input_tokens` excludes cache reads; charge both fields.
 * - openai_inclusive: cached tokens are a subset of `input_tokens`; subtract before
 *   applying the uncached input rate (OpenAI Responses / OpenRouter Chat Completions).
 */
export type CachedInputBilling = "anthropic_separate" | "openai_inclusive";

/**
 * Exact-model pricing snapshot. Rates are micro-USD per 1_000_000 tokens.
 * Do not invent entries — only verified production prices or test fixtures.
 */
export interface ModelPricingEntry {
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly pricingVersion: string;
  readonly currency: "USD";
  readonly inputMicrosPerMTok: number;
  readonly outputMicrosPerMTok: number;
  /** Required when cachedInputTokens > 0 on a priced event. */
  readonly cachedInputMicrosPerMTok?: number;
  readonly cachedInputBilling: CachedInputBilling;
}

export interface ModelPricingRegistry {
  lookup(
    provider: ProviderCredentialProvider,
    model: string,
  ): ModelPricingEntry | null;
}

export type EstimatedCostResult =
  | {
      readonly status: "priced";
      readonly estimatedCostMicros: number;
      readonly currency: "USD";
      readonly pricingVersion: string;
    }
  | {
      readonly status: "unpriced";
      readonly reason:
        | "unknown_model"
        | "incomplete_usage"
        | "incomplete_pricing"
        | "invalid_usage";
    };

/** Exact provider+model match only — no fuzzy / prefix matching. */
export function createModelPricingRegistry(
  entries: readonly ModelPricingEntry[],
): ModelPricingRegistry {
  const byKey = new Map<string, ModelPricingEntry>();
  for (const entry of entries) {
    byKey.set(pricingKey(entry.provider, entry.model), entry);
  }
  return {
    lookup(provider, model) {
      return byKey.get(pricingKey(provider, model)) ?? null;
    },
  };
}

function pricingKey(
  provider: ProviderCredentialProvider,
  model: string,
): string {
  return `${provider}\0${model}`;
}

/**
 * Pure cost estimate from trusted attribution identity + normalized usage +
 * a pricing snapshot. Never invents missing usage or prices.
 *
 * Reasoning tokens are never charged separately: providers that report them
 * already include them in output token totals for billing.
 */
export function estimateModelCost(input: {
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly tokens: ModelUsageTokens;
  readonly pricing: ModelPricingEntry | null;
}): EstimatedCostResult {
  const { tokens, pricing } = input;
  if (!pricing) {
    return { status: "unpriced", reason: "unknown_model" };
  }
  if (pricing.provider !== input.provider || pricing.model !== input.model) {
    return { status: "unpriced", reason: "unknown_model" };
  }

  if (tokens.inputTokens === null || tokens.outputTokens === null) {
    return { status: "unpriced", reason: "incomplete_usage" };
  }
  if (tokens.inputTokens < 0 || tokens.outputTokens < 0) {
    return { status: "unpriced", reason: "invalid_usage" };
  }

  const cached = tokens.cachedInputTokens;
  if (cached !== null && cached < 0) {
    return { status: "unpriced", reason: "invalid_usage" };
  }

  let billableUncachedInput = tokens.inputTokens;
  let billableCachedInput = 0;

  if (cached !== null && cached > 0) {
    if (typeof pricing.cachedInputMicrosPerMTok !== "number") {
      return { status: "unpriced", reason: "incomplete_pricing" };
    }
    if (pricing.cachedInputBilling === "openai_inclusive") {
      billableUncachedInput = tokens.inputTokens - cached;
      if (billableUncachedInput < 0) {
        return { status: "unpriced", reason: "invalid_usage" };
      }
      billableCachedInput = cached;
    } else {
      // anthropic_separate: input and cache-read are distinct billable units.
      billableCachedInput = cached;
    }
  }

  // reasoningTokens are observational only — already inside outputTokens for billing.
  const estimatedCostMicros =
    tokensCostMicros(billableUncachedInput, pricing.inputMicrosPerMTok) +
    tokensCostMicros(billableCachedInput, pricing.cachedInputMicrosPerMTok ?? 0) +
    tokensCostMicros(tokens.outputTokens, pricing.outputMicrosPerMTok);

  return {
    status: "priced",
    estimatedCostMicros,
    currency: pricing.currency,
    pricingVersion: pricing.pricingVersion,
  };
}

/** Integer micro-USD from token count × micro-USD-per-MTok (half-up). */
export function tokensCostMicros(
  tokens: number,
  microsPerMTok: number,
): number {
  if (tokens === 0 || microsPerMTok === 0) {
    return 0;
  }
  const product = BigInt(tokens) * BigInt(microsPerMTok);
  return Number((product + 500_000n) / 1_000_000n);
}

/**
 * Production registry.
 *
 * Intentionally empty: no verified provider price table lives in-repo yet.
 * Unknown models stay unpriced (null cost) while raw usage still records.
 * Add exact-model entries only from documented provider pricing + a version key.
 */
export const PRODUCTION_MODEL_PRICING: readonly ModelPricingEntry[] = [];

export const productionModelPricingRegistry = createModelPricingRegistry(
  PRODUCTION_MODEL_PRICING,
);
