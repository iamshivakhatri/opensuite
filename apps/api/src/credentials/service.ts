import {
  CREDENTIAL_ENCRYPTION_VERSION,
  type createCredentialCipher,
} from "./crypto.js";
import type { ProviderCredentialRepository } from "./repository.js";
import type {
  ProviderCredentialMetadata,
  ProviderCredentialProvider,
} from "./types.js";

type CredentialCipher = ReturnType<typeof createCredentialCipher>;

function toMetadata(credential: {
  id: string;
  provider: ProviderCredentialProvider;
  createdAt: Date;
  updatedAt: Date;
}): ProviderCredentialMetadata {
  return {
    id: credential.id,
    provider: credential.provider,
    connected: true,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  };
}

/** Domain API for server-side credential lifecycle work in later milestones. */
export function createProviderCredentialService(
  repository: ProviderCredentialRepository,
  cipher: CredentialCipher,
) {
  return {
    async save(input: {
      userId: string;
      provider: ProviderCredentialProvider;
      secret: string;
    }): Promise<ProviderCredentialMetadata> {
      const encryptedPayload = cipher.encrypt(input.secret, input);
      const credential = await repository.save({
        userId: input.userId,
        provider: input.provider,
        encryptedPayload,
        encryptionVersion: CREDENTIAL_ENCRYPTION_VERSION,
      });
      return toMetadata(credential);
    },

    async getSecret(input: {
      userId: string;
      provider: ProviderCredentialProvider;
    }): Promise<string | null> {
      const credential = await repository.get(input.userId, input.provider);
      return credential
        ? cipher.decrypt(credential.encryptedPayload, input)
        : null;
    },

    async getMetadata(input: {
      userId: string;
      provider: ProviderCredentialProvider;
    }): Promise<ProviderCredentialMetadata | null> {
      const credential = await repository.get(input.userId, input.provider);
      return credential ? toMetadata(credential) : null;
    },

    delete(input: { userId: string; provider: ProviderCredentialProvider }) {
      return repository.delete(input.userId, input.provider);
    },
  };
}
