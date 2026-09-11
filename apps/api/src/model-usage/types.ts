import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { CredentialSource } from "../ai-preferences/types.js";

/** Provider-reported token counts. Null means the provider did not report that field. */
export interface ModelUsageTokens {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
}

/**
 * Immutable cost snapshot written with the usage row.
 * All null when pricing was unknown / calculation impossible.
 * Never invent zero cost.
 */
export interface ModelUsageCostSnapshot {
  readonly estimatedCostMicros: number | null;
  readonly costCurrency: string | null;
  readonly pricingVersion: string | null;
}

/** Trusted attribution for one completed provider request (never from model output). */
export interface ModelUsageAttribution {
  readonly userId: string;
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly credentialSource: CredentialSource;
  /** Correlation only — not required for accounting correctness. */
  readonly agentRunId?: string | null;
}

export interface RecordModelUsageInput extends ModelUsageAttribution {
  readonly tokens: ModelUsageTokens;
  readonly cost?: ModelUsageCostSnapshot;
}

export interface ModelUsageEvent {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly credentialSource: CredentialSource;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostMicros: number | null;
  readonly costCurrency: string | null;
  readonly pricingVersion: string | null;
  readonly agentRunId: string | null;
  readonly createdAt: string;
}

export interface ModelUsageAggregate {
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

/**
 * Cost aggregation over stored immutable snapshots (never re-priced).
 * `estimatedCostMicros` is null when there are no priced events (unknown ≠ zero).
 */
export interface ModelUsageCostAggregate {
  readonly eventCount: number;
  readonly pricedEventCount: number;
  readonly unpricedEventCount: number;
  readonly estimatedCostMicros: number | null;
  readonly costCurrency: string | null;
  readonly byCredentialSource: {
    readonly byok: {
      readonly eventCount: number;
      readonly pricedEventCount: number;
      readonly estimatedCostMicros: number | null;
    };
    readonly managed: {
      readonly eventCount: number;
      readonly pricedEventCount: number;
      readonly estimatedCostMicros: number | null;
    };
  };
}
