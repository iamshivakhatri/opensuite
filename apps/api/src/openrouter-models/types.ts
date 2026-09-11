/**
 * Safe managed-model row for Settings / model picker.
 * Pricing strings are display/estimate metadata only — not authoritative billing.
 */
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
  /** OpenRouter author/org prefix when present in the model id (e.g. "openai"). */
  readonly author: string | null;
}

/** Raw OpenRouter Models API model object (subset we care about). */
export interface OpenRouterRawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly context_length?: unknown;
  readonly supported_parameters?: unknown;
  readonly pricing?: unknown;
  readonly architecture?: {
    readonly output_modalities?: unknown;
  };
}

export interface OpenRouterModelsListResponse {
  readonly data?: unknown;
}

export class OpenRouterCatalogError extends Error {
  constructor(
    readonly code: "CATALOG_UNAVAILABLE" | "MODEL_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterCatalogError";
  }
}
