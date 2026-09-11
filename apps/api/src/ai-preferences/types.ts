import type { ProviderCredentialProvider } from "../credentials/types.js";

export const credentialSources = ["byok", "managed"] as const;
export type CredentialSource = (typeof credentialSources)[number];

export interface AiPreference {
  readonly provider: ProviderCredentialProvider;
  readonly model: string;
  readonly credentialSource: CredentialSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}
