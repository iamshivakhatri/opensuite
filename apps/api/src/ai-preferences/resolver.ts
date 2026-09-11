import type { AgentModelConfig } from "../config/index.js";
import type { ProviderCredentialService } from "../credentials/service.js";
import type { ProviderCredentialProvider } from "../credentials/types.js";
import {
  OpenRouterCatalogError,
} from "../openrouter-models/types.js";
import type { OpenRouterManagedModelCatalog } from "../openrouter-models/catalog.js";
import type { AiPreferenceService } from "./service.js";
import type { CredentialSource } from "./types.js";

export class AiConfigurationError extends Error {
  constructor(
    readonly code:
      | "BYOK_CREDENTIAL_MISSING"
      | "MANAGED_PROVIDER_UNCONFIGURED"
      | "MODEL_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export interface ResolvedAiModel {
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly credentialSource: CredentialSource;
  readonly apiKey: string;
}

function managedKey(
  config: AgentModelConfig,
  provider: ProviderCredentialProvider,
): string | null {
  if (provider === "anthropic") {
    return config.provider === "anthropic" ? config.anthropicApiKey : null;
  }
  if (provider === "openai") {
    return config.provider === "openai" ? config.openaiApiKey : null;
  }
  // Managed OpenRouter gateway key is available whenever configured,
  // independent of AGENT_MODEL_PROVIDER default.
  return config.openrouterApiKey;
}

function managedDefaultModel(
  config: AgentModelConfig,
  provider: ProviderCredentialProvider,
): string | null {
  if (config.provider !== provider) return null;
  if (provider === "anthropic") return config.anthropicModel;
  if (provider === "openai") return config.openaiModel;
  return config.openrouterModel;
}

/** Resolves a single user-owned or server-owned credential before model creation. */
export function createAiModelResolver(input: {
  preferences: AiPreferenceService;
  credentials: ProviderCredentialService | null;
  managed: AgentModelConfig;
  /** Required to validate managed OpenRouter model availability at resolve time. */
  catalog?: OpenRouterManagedModelCatalog | null;
}) {
  return {
    async resolve(userId: string): Promise<ResolvedAiModel> {
      const preference = await input.preferences.get(userId);
      if (!preference) {
        const provider = input.managed.provider;
        if (provider === "unconfigured" || provider === "fake") {
          throw new AiConfigurationError(
            "MANAGED_PROVIDER_UNCONFIGURED",
            "No managed AI provider is configured",
          );
        }
        const apiKey = managedKey(input.managed, provider);
        const model = managedDefaultModel(input.managed, provider);
        if (!apiKey || !model) {
          throw new AiConfigurationError(
            "MANAGED_PROVIDER_UNCONFIGURED",
            "Managed AI provider is not configured",
          );
        }
        return { provider, model, credentialSource: "managed", apiKey };
      }

      if (preference.credentialSource === "byok") {
        const apiKey = input.credentials
          ? await input.credentials.getSecret({
              userId,
              provider: preference.provider,
            })
          : null;
        if (!apiKey) {
          throw new AiConfigurationError(
            "BYOK_CREDENTIAL_MISSING",
            "A credential is required for the selected BYOK provider",
          );
        }
        return {
          provider: preference.provider,
          model: preference.model,
          credentialSource: preference.credentialSource,
          apiKey,
        };
      }

      // Managed preference: OpenRouter is the managed gateway.
      if (preference.provider === "openrouter") {
        const apiKey = managedKey(input.managed, "openrouter");
        if (!apiKey) {
          throw new AiConfigurationError(
            "MANAGED_PROVIDER_UNCONFIGURED",
            "Managed OpenRouter provider is not configured",
          );
        }
        if (input.catalog) {
          try {
            await input.catalog.requireManagedModel(preference.model);
          } catch (error) {
            if (
              error instanceof OpenRouterCatalogError &&
              error.code === "MODEL_UNAVAILABLE"
            ) {
              throw new AiConfigurationError(
                "MODEL_UNAVAILABLE",
                "The selected managed model is not available",
              );
            }
            if (
              error instanceof OpenRouterCatalogError &&
              error.code === "CATALOG_UNAVAILABLE"
            ) {
              throw new AiConfigurationError(
                "MANAGED_PROVIDER_UNCONFIGURED",
                "Managed model catalog is temporarily unavailable",
              );
            }
            throw error;
          }
        }
        return {
          provider: "openrouter",
          model: preference.model,
          credentialSource: "managed",
          apiKey,
        };
      }

      // Legacy managed openai/anthropic preferences (pre-B2.1) still resolve
      // against the configured default provider key when present.
      const apiKey = managedKey(input.managed, preference.provider);
      if (!apiKey) {
        throw new AiConfigurationError(
          "MANAGED_PROVIDER_UNCONFIGURED",
          "Managed AI provider is not configured for the selected provider",
        );
      }
      return {
        provider: preference.provider,
        model: preference.model,
        credentialSource: preference.credentialSource,
        apiKey,
      };
    },
  };
}
