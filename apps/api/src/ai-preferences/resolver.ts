import type { AgentModelConfig } from "../config/index.js";
import type { ProviderCredentialService } from "../credentials/service.js";
import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { AiPreferenceService } from "./service.js";
import type { CredentialSource } from "./types.js";

export class AiConfigurationError extends Error {
  constructor(readonly code: "BYOK_CREDENTIAL_MISSING" | "MANAGED_PROVIDER_UNCONFIGURED", message: string) {
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

function managedKey(config: AgentModelConfig, provider: ProviderCredentialProvider): string | null {
  if (config.provider !== provider) return null;
  if (provider === "anthropic") return config.anthropicApiKey;
  if (provider === "openai") return config.openaiApiKey;
  return config.openrouterApiKey;
}

function managedModel(config: AgentModelConfig, provider: ProviderCredentialProvider): string | null {
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
}) {
  return {
    async resolve(userId: string): Promise<ResolvedAiModel> {
      const preference = await input.preferences.get(userId);
      if (!preference) {
        const provider = input.managed.provider;
        if (provider === "unconfigured" || provider === "fake") {
          throw new AiConfigurationError("MANAGED_PROVIDER_UNCONFIGURED", "No managed AI provider is configured");
        }
        const apiKey = managedKey(input.managed, provider);
        const model = managedModel(input.managed, provider);
        if (!apiKey || !model) throw new AiConfigurationError("MANAGED_PROVIDER_UNCONFIGURED", "Managed AI provider is not configured");
        return { provider, model, credentialSource: "managed", apiKey };
      }

      if (preference.credentialSource === "byok") {
        const apiKey = input.credentials
          ? await input.credentials.getSecret({ userId, provider: preference.provider })
          : null;
        if (!apiKey) throw new AiConfigurationError("BYOK_CREDENTIAL_MISSING", "A credential is required for the selected BYOK provider");
        return {
          provider: preference.provider,
          model: preference.model,
          credentialSource: preference.credentialSource,
          apiKey,
        };
      }

      const apiKey = managedKey(input.managed, preference.provider);
      if (!apiKey) throw new AiConfigurationError("MANAGED_PROVIDER_UNCONFIGURED", "Managed AI provider is not configured for the selected provider");
      return {
        provider: preference.provider,
        model: preference.model,
        credentialSource: preference.credentialSource,
        apiKey,
      };
    },
  };
}
