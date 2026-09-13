import type { ProviderCredentialProvider } from "./types.js";

/**
 * Cheap BYOK checks against provider HTTP APIs.
 * Does not call chat/completions — no completion token spend.
 * OpenRouter key checks use `/api/v1/key` (models list is public).
 */

export type ProviderProbeFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderProbeFailureCode =
  | "INVALID_API_KEY"
  | "INVALID_MODEL"
  | "PROVIDER_UNREACHABLE";

export type ProviderProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: ProviderProbeFailureCode;
      readonly message: string;
    };

const PROVIDER_LABEL: Record<ProviderCredentialProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Auth-required — OpenRouter `/models` is public and accepts any/missing key. */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const ANTHROPIC_VERSION = "2023-06-01";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authHeaders(
  provider: ProviderCredentialProvider,
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function apiKeyProbeUrl(provider: ProviderCredentialProvider): string {
  if (provider === "openai") return OPENAI_MODELS_URL;
  if (provider === "anthropic") return ANTHROPIC_MODELS_URL;
  return OPENROUTER_KEY_URL;
}

function modelRetrieveUrl(
  provider: Exclude<ProviderCredentialProvider, "openrouter">,
  modelId: string,
): string {
  const base = provider === "openai" ? OPENAI_MODELS_URL : ANTHROPIC_MODELS_URL;
  return `${base}/${encodeURIComponent(modelId)}`;
}

function rejectedKeyMessage(provider: ProviderCredentialProvider): string {
  return `That ${PROVIDER_LABEL[provider]} API key was rejected. Check the key and try again.`;
}

function unreachableMessage(provider: ProviderCredentialProvider): string {
  return `Could not reach ${PROVIDER_LABEL[provider]} to verify the key. Try again in a moment.`;
}

function invalidModelMessage(
  provider: ProviderCredentialProvider,
  modelId: string,
): string {
  return `"${modelId}" was not found for your ${PROVIDER_LABEL[provider]} key. Check the model id and try again.`;
}

function mapAuthFailure(
  provider: ProviderCredentialProvider,
  status: number,
): ProviderProbeResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "INVALID_API_KEY",
      message: rejectedKeyMessage(provider),
    };
  }
  return {
    ok: false,
    code: "PROVIDER_UNREACHABLE",
    message: unreachableMessage(provider),
  };
}

function extractModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const ids: string[] = [];
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

export interface ProviderCredentialProbe {
  verifyApiKey(input: {
    readonly provider: ProviderCredentialProvider;
    readonly apiKey: string;
  }): Promise<ProviderProbeResult>;
  verifyModel(input: {
    readonly provider: ProviderCredentialProvider;
    readonly apiKey: string;
    readonly model: string;
  }): Promise<ProviderProbeResult>;
}

export function createProviderCredentialProbe(
  fetchImpl: ProviderProbeFetch = fetch,
): ProviderCredentialProbe {
  async function getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown } | { error: true }> {
    try {
      const response = await fetchImpl(url, { method: "GET", headers });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      return { error: true };
    }
  }

  return {
    async verifyApiKey(input) {
      const provider = input.provider;
      const apiKey = input.apiKey.trim();
      if (!apiKey) {
        return {
          ok: false,
          code: "INVALID_API_KEY",
          message: "API key is required",
        };
      }

      const result = await getJson(
        apiKeyProbeUrl(provider),
        authHeaders(provider, apiKey),
      );
      if ("error" in result) {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          message: unreachableMessage(provider),
        };
      }
      if (result.status >= 200 && result.status < 300) {
        return { ok: true };
      }
      return mapAuthFailure(provider, result.status);
    },

    async verifyModel(input) {
      const provider = input.provider;
      const apiKey = input.apiKey.trim();
      const model = input.model.trim();
      if (!apiKey) {
        return {
          ok: false,
          code: "INVALID_API_KEY",
          message: `Connect a ${PROVIDER_LABEL[provider]} key before saving a model.`,
        };
      }
      if (!model) {
        return {
          ok: false,
          code: "INVALID_MODEL",
          message: "Model is required",
        };
      }

      if (provider === "openrouter") {
        // Models list is public; authenticate via /key first, then check id.
        const keyCheck = await getJson(
          OPENROUTER_KEY_URL,
          authHeaders(provider, apiKey),
        );
        if ("error" in keyCheck) {
          return {
            ok: false,
            code: "PROVIDER_UNREACHABLE",
            message: unreachableMessage(provider),
          };
        }
        if (keyCheck.status === 401 || keyCheck.status === 403) {
          return {
            ok: false,
            code: "INVALID_API_KEY",
            message: rejectedKeyMessage(provider),
          };
        }
        if (keyCheck.status < 200 || keyCheck.status >= 300) {
          return {
            ok: false,
            code: "PROVIDER_UNREACHABLE",
            message: unreachableMessage(provider),
          };
        }

        const result = await getJson(
          OPENROUTER_MODELS_URL,
          authHeaders(provider, apiKey),
        );
        if ("error" in result) {
          return {
            ok: false,
            code: "PROVIDER_UNREACHABLE",
            message: unreachableMessage(provider),
          };
        }
        if (result.status < 200 || result.status >= 300) {
          return {
            ok: false,
            code: "PROVIDER_UNREACHABLE",
            message: unreachableMessage(provider),
          };
        }
        const ids = extractModelIds(result.body);
        if (!ids.includes(model)) {
          return {
            ok: false,
            code: "INVALID_MODEL",
            message: invalidModelMessage(provider, model),
          };
        }
        return { ok: true };
      }

      const result = await getJson(
        modelRetrieveUrl(provider, model),
        authHeaders(provider, apiKey),
      );
      if ("error" in result) {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          message: unreachableMessage(provider),
        };
      }
      if (result.status === 401 || result.status === 403) {
        return {
          ok: false,
          code: "INVALID_API_KEY",
          message: rejectedKeyMessage(provider),
        };
      }
      if (result.status === 404) {
        return {
          ok: false,
          code: "INVALID_MODEL",
          message: invalidModelMessage(provider, model),
        };
      }
      if (result.status >= 200 && result.status < 300) {
        return { ok: true };
      }
      return {
        ok: false,
        code: "PROVIDER_UNREACHABLE",
        message: unreachableMessage(provider),
      };
    },
  };
}

/** Always-ok probe for unit tests that do not exercise provider HTTP. */
export function createPassthroughProviderProbe(): ProviderCredentialProbe {
  return {
    verifyApiKey: async () => ({ ok: true }),
    verifyModel: async () => ({ ok: true }),
  };
}
