export const providerCredentialProviders = [
  "anthropic",
  "openai",
  "openrouter",
] as const;

export type ProviderCredentialProvider =
  (typeof providerCredentialProviders)[number];

export interface ProviderCredentialMetadata {
  readonly id: string;
  readonly provider: ProviderCredentialProvider;
  readonly connected: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
