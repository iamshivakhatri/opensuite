import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { ProviderCredentialProvider } from "./types.js";

export const CREDENTIAL_ENCRYPTION_VERSION = 1;

export interface EncryptedCredentialPayload {
  readonly version: typeof CREDENTIAL_ENCRYPTION_VERSION;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

interface CredentialContext {
  readonly userId: string;
  readonly provider: ProviderCredentialProvider;
}

function encryptionKey(value: string | null | undefined): Buffer {
  const key = value?.trim();
  if (!key) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY is required for provider credentials");
  }

  const decoded = /^[0-9a-f]{64}$/i.test(key)
    ? Buffer.from(key, "hex")
    : /^[A-Za-z0-9+/]{43}=$/.test(key)
      ? Buffer.from(key, "base64")
      : null;
  if (!decoded || decoded.length !== 32) {
    throw new Error(
      "AI_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex value",
    );
  }
  return decoded;
}

function associatedData(context: CredentialContext): Buffer {
  return Buffer.from(`${context.userId}:${context.provider}`, "utf8");
}

/** Server-only AES-256-GCM encryption for a provider credential. */
export function createCredentialCipher(keyValue: string | null | undefined) {
  const key = encryptionKey(keyValue);

  return {
    encrypt(secret: string, context: CredentialContext): EncryptedCredentialPayload {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(associatedData(context));
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

      return {
        version: CREDENTIAL_ENCRYPTION_VERSION,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    },

    decrypt(payload: EncryptedCredentialPayload, context: CredentialContext): string {
      if (payload.version !== CREDENTIAL_ENCRYPTION_VERSION) {
        throw new Error("Unsupported provider credential encryption version");
      }

      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(payload.nonce, "base64"),
        );
        decipher.setAAD(associatedData(context));
        decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(payload.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Unable to decrypt provider credential");
      }
    },
  };
}
