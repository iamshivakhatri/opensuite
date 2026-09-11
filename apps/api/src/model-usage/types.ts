import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { CredentialSource } from "../ai-preferences/types.js";

/** Provider-reported token counts. Null means the provider did not report that field. */
export interface ModelUsageTokens {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
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
