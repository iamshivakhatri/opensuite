import {
  OpenRouterCatalogError,
  type ManagedAiModel,
  type OpenRouterModelsListResponse,
  type OpenRouterRawModel,
} from "./types.js";

/** Same origin as OpenRouter Chat Completions (`OPENROUTER_BASE_URL`). */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Agent runtime requires tool calling; Models API filter matches that. */
export const MANAGED_MODEL_QUERY =
  "output_modalities=text&supported_parameters=tools";

export const DEFAULT_CATALOG_TTL_MS = 10 * 60 * 1000;

export type OpenRouterCatalogFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenRouterManagedModelCatalogOptions {
  /** Optional OpenRouter key — Models API is public, but auth is fine when present. */
  readonly apiKey?: string | null;
  readonly fetchImpl?: OpenRouterCatalogFetch;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Override list URL (tests). Defaults to OpenRouter Models API + capability filters. */
  readonly listUrl?: string;
}

interface CatalogCacheEntry {
  readonly models: readonly ManagedAiModel[];
  readonly fetchedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNonNegNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function pricingString(
  pricing: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = pricing[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize one OpenRouter model into the safe managed catalog shape.
 * Returns null when the model lacks an id or required agent capabilities.
 */
export function normalizeManagedAiModel(
  raw: OpenRouterRawModel,
): ManagedAiModel | null {
  const id = asString(raw.id);
  if (!id) return null;

  const supportedParameters = asStringArray(raw.supported_parameters);
  if (!supportedParameters.includes("tools")) {
    return null;
  }

  const outputModalities = asStringArray(
    isRecord(raw.architecture) ? raw.architecture.output_modalities : undefined,
  );
  // Upstream filter should already restrict to text; keep a light local guard.
  if (outputModalities.length > 0 && !outputModalities.includes("text")) {
    return null;
  }

  const pricingRaw = isRecord(raw.pricing) ? raw.pricing : {};
  const slash = id.indexOf("/");
  const author = slash > 0 ? id.slice(0, slash) : null;

  return {
    id,
    name: asString(raw.name) ?? id,
    contextLength: asNonNegNumber(raw.context_length),
    supportedParameters,
    pricing: {
      ...(pricingString(pricingRaw, "prompt") !== undefined
        ? { prompt: pricingString(pricingRaw, "prompt") }
        : {}),
      ...(pricingString(pricingRaw, "completion") !== undefined
        ? { completion: pricingString(pricingRaw, "completion") }
        : {}),
      ...(pricingString(pricingRaw, "request") !== undefined
        ? { request: pricingString(pricingRaw, "request") }
        : {}),
      ...(pricingString(pricingRaw, "image") !== undefined
        ? { image: pricingString(pricingRaw, "image") }
        : {}),
      ...(pricingString(pricingRaw, "web_search") !== undefined
        ? { webSearch: pricingString(pricingRaw, "web_search") }
        : {}),
      ...(pricingString(pricingRaw, "internal_reasoning") !== undefined
        ? { internalReasoning: pricingString(pricingRaw, "internal_reasoning") }
        : {}),
      ...(pricingString(pricingRaw, "input_cache_read") !== undefined
        ? { inputCacheRead: pricingString(pricingRaw, "input_cache_read") }
        : {}),
      ...(pricingString(pricingRaw, "input_cache_write") !== undefined
        ? { inputCacheWrite: pricingString(pricingRaw, "input_cache_write") }
        : {}),
    },
    author,
  };
}

export function normalizeManagedAiModels(
  payload: OpenRouterModelsListResponse | unknown,
): ManagedAiModel[] {
  const data = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  const out: ManagedAiModel[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const model = normalizeManagedAiModel(item as OpenRouterRawModel);
    if (model) out.push(model);
  }
  return out;
}

/**
 * In-process TTL cache of OpenRouter managed models.
 * Stale-on-error: if refresh fails but a prior success exists, return stale.
 */
export function createOpenRouterManagedModelCatalog(
  options: OpenRouterManagedModelCatalogOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  const listUrl =
    options.listUrl ?? `${OPENROUTER_MODELS_URL}?${MANAGED_MODEL_QUERY}`;

  let cache: CatalogCacheEntry | null = null;
  let inFlight: Promise<readonly ManagedAiModel[]> | null = null;

  async function fetchFresh(): Promise<readonly ManagedAiModel[]> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const apiKey = options.apiKey?.trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(listUrl, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new OpenRouterCatalogError(
        "CATALOG_UNAVAILABLE",
        `OpenRouter model catalog unavailable (${response.status})`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenRouterCatalogError(
        "CATALOG_UNAVAILABLE",
        "OpenRouter model catalog returned invalid JSON",
      );
    }

    const models = normalizeManagedAiModels(payload);
    cache = { models, fetchedAt: now() };
    return models;
  }

  async function listManagedModels(): Promise<readonly ManagedAiModel[]> {
    const hit = cache;
    if (hit && now() - hit.fetchedAt < ttlMs) {
      return hit.models;
    }

    if (!inFlight) {
      inFlight = fetchFresh().finally(() => {
        inFlight = null;
      });
    }

    try {
      return await inFlight;
    } catch (error) {
      if (cache) {
        return cache.models;
      }
      if (error instanceof OpenRouterCatalogError) {
        throw error;
      }
      throw new OpenRouterCatalogError(
        "CATALOG_UNAVAILABLE",
        error instanceof Error
          ? error.message
          : "OpenRouter model catalog unavailable",
      );
    }
  }

  return {
    listManagedModels,

    async getManagedModel(modelId: string): Promise<ManagedAiModel | null> {
      const models = await listManagedModels();
      return models.find((model) => model.id === modelId) ?? null;
    },

    async requireManagedModel(modelId: string): Promise<ManagedAiModel> {
      const model = await this.getManagedModel(modelId);
      if (!model) {
        throw new OpenRouterCatalogError(
          "MODEL_UNAVAILABLE",
          "The selected managed model is not available",
        );
      }
      return model;
    },

    /** Test helper — inspect cache without fetching. */
    _peekCache(): CatalogCacheEntry | null {
      return cache;
    },

    /** Test helper — seed cache. */
    _seedCache(models: readonly ManagedAiModel[], fetchedAt = now()): void {
      cache = { models, fetchedAt };
    },
  };
}

export type OpenRouterManagedModelCatalog = ReturnType<
  typeof createOpenRouterManagedModelCatalog
>;
