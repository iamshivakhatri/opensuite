/**
 * Pure helpers for AI & Models Settings — formatting, filtering, preference
 * payloads. Keep secrets out of this module; it only handles public metadata.
 */

export const AI_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiCredentialSource = "byok" | "managed";

export type AiMode = "managed" | "byok";

export interface PublicProviderCredential {
  readonly provider: AiProvider;
  readonly connected: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiPreference {
  readonly provider: AiProvider;
  readonly model: string;
  readonly credentialSource: AiCredentialSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedAiModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
  readonly supportedParameters: readonly string[];
  readonly pricing: {
    readonly prompt?: string;
    readonly completion?: string;
    readonly request?: string;
    readonly image?: string;
    readonly webSearch?: string;
    readonly internalReasoning?: string;
    readonly inputCacheRead?: string;
    readonly inputCacheWrite?: string;
  };
  readonly author: string | null;
}

export interface AiTrialStatus {
  readonly enabled: boolean;
  readonly originalGrantMicros: number;
  readonly balanceMicros: number;
  readonly exhausted: boolean;
}

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

/** Honest placeholders from current backend defaults — not a catalog. */
export const BYOK_MODEL_PLACEHOLDERS: Record<AiProvider, string> = {
  openai: "gpt-4.1",
  anthropic: "claude-sonnet-4-5",
  openrouter: "openai/gpt-4.1",
};

export function modeFromPreference(
  preference: AiPreference | null,
): AiMode {
  if (!preference) return "managed";
  return preference.credentialSource === "byok" ? "byok" : "managed";
}

export function buildManagedPreferencePayload(modelId: string): {
  provider: "openrouter";
  model: string;
  credentialSource: "managed";
} {
  return {
    provider: "openrouter",
    model: modelId.trim(),
    credentialSource: "managed",
  };
}

export function buildByokPreferencePayload(
  provider: AiProvider,
  model: string,
): {
  provider: AiProvider;
  model: string;
  credentialSource: "byok";
} {
  return {
    provider,
    model: model.trim(),
    credentialSource: "byok",
  };
}

/** Map API credential list onto the three supported providers. */
export function credentialStatusByProvider(
  credentials: readonly PublicProviderCredential[],
): Record<AiProvider, PublicProviderCredential | null> {
  const map: Record<AiProvider, PublicProviderCredential | null> = {
    openai: null,
    anthropic: null,
    openrouter: null,
  };
  for (const row of credentials) {
    if ((AI_PROVIDERS as readonly string[]).includes(row.provider)) {
      map[row.provider] = row;
    }
  }
  return map;
}

export function isProviderConnected(
  credentials: readonly PublicProviderCredential[],
  provider: AiProvider,
): boolean {
  return credentials.some((row) => row.provider === provider && row.connected);
}

export function filterManagedModels(
  models: readonly ManagedAiModel[],
  query: string,
): ManagedAiModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((model) => {
    const haystack = `${model.name} ${model.id} ${model.author ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function findManagedModel(
  models: readonly ManagedAiModel[],
  modelId: string | null | undefined,
): ManagedAiModel | null {
  if (!modelId) return null;
  return models.find((model) => model.id === modelId) ?? null;
}

/**
 * Saved managed model missing from the live catalog — do not silently replace.
 */
export function isManagedModelUnavailable(
  models: readonly ManagedAiModel[],
  catalogLoaded: boolean,
  savedModelId: string | null | undefined,
): boolean {
  if (!catalogLoaded || !savedModelId) return false;
  return findManagedModel(models, savedModelId) === null;
}

/** Micro-USD → display dollars; negatives clamp to $0.00 for overshoot. */
export function formatUsdFromMicros(micros: number): string {
  const dollars = Math.max(0, micros) / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars);
}

export type TrialDisplay = {
  readonly kind: "disabled" | "available" | "exhausted";
  readonly balanceLabel: string;
  readonly statusLabel: string;
};

export function trialDisplay(status: AiTrialStatus): TrialDisplay {
  if (!status.enabled) {
    return {
      kind: "disabled",
      balanceLabel: "$0.00",
      statusLabel: "Managed AI unavailable",
    };
  }
  const balanceLabel = formatUsdFromMicros(status.balanceMicros);
  if (status.exhausted || status.balanceMicros <= 0) {
    return {
      kind: "exhausted",
      balanceLabel: "$0.00 remaining",
      statusLabel: "Trial exhausted",
    };
  }
  return {
    kind: "available",
    balanceLabel: `${balanceLabel} remaining`,
    statusLabel: "OpenSuite trial",
  };
}

/** OpenRouter per-token price string → concise $/M tokens estimate. */
export function formatPerMillionTokens(pricePerToken: string | undefined): string | null {
  if (!pricePerToken) return null;
  const n = Number(pricePerToken);
  if (!Number.isFinite(n) || n < 0) return null;
  const perM = n * 1_000_000;
  if (perM === 0) return "$0/M";
  if (perM < 0.01) return `$${perM.toPrecision(2)}/M`;
  if (perM < 1) return `$${perM.toFixed(3)}/M`;
  return `$${perM.toFixed(2)}/M`;
}

export function formatContextLength(contextLength: number | null): string | null {
  if (contextLength == null || !Number.isFinite(contextLength) || contextLength <= 0) {
    return null;
  }
  if (contextLength >= 1_000_000) {
    const m = contextLength / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  if (contextLength >= 1_000) {
    const k = contextLength / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K ctx`;
  }
  return `${contextLength} ctx`;
}

export function managedModelMetaLine(model: ManagedAiModel): string {
  const parts: string[] = [];
  if (model.author) parts.push(model.author);
  const ctx = formatContextLength(model.contextLength);
  if (ctx) parts.push(ctx);
  const prompt = formatPerMillionTokens(model.pricing.prompt);
  const completion = formatPerMillionTokens(model.pricing.completion);
  if (prompt && completion) {
    parts.push(`${prompt} in · ${completion} out`);
  } else if (prompt) {
    parts.push(`${prompt} in`);
  } else if (completion) {
    parts.push(`${completion} out`);
  }
  return parts.join(" · ");
}

/** Active-mode summary for the settings page header strip. */
export function activeModeSummary(input: {
  readonly mode: AiMode;
  readonly preference: AiPreference | null;
  readonly managedModel: ManagedAiModel | null;
  readonly managedUnavailable: boolean;
}): string {
  if (input.mode === "managed") {
    if (input.managedUnavailable && input.preference?.model) {
      return `OpenSuite managed · ${input.preference.model} (unavailable)`;
    }
    if (input.managedModel) {
      return `OpenSuite managed · ${input.managedModel.name}`;
    }
    if (input.preference?.model) {
      return `OpenSuite managed · ${input.preference.model}`;
    }
    return "OpenSuite managed · choose a model";
  }
  if (input.preference?.credentialSource === "byok") {
    return `Your key · ${PROVIDER_LABELS[input.preference.provider]} · ${input.preference.model}`;
  }
  return "Your key · choose provider and model";
}

/**
 * After a successful connect/replace, callers must clear the key from
 * component state. This helper returns the empty string so tests can assert
 * the post-success value without touching React.
 */
export function clearedApiKeyAfterSuccess(): string {
  return "";
}

/** Public credential payloads must never include secret fields. */
export function assertSafeCredentialPayload(
  value: unknown,
): asserts value is PublicProviderCredential {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid credential payload");
  }
  const row = value as Record<string, unknown>;
  for (const forbidden of [
    "apiKey",
    "secret",
    "ciphertext",
    "encrypted",
    "key",
  ]) {
    if (forbidden in row) {
      throw new Error(`Credential payload leaked secret field: ${forbidden}`);
    }
  }
  if (typeof row.provider !== "string" || typeof row.connected !== "boolean") {
    throw new Error("Invalid credential payload shape");
  }
}
