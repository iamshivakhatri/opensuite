import { and, eq } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { EncryptedCredentialPayload } from "./crypto.js";
import type { ProviderCredentialProvider } from "./types.js";

export interface StoredProviderCredential {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderCredentialProvider;
  readonly encryptedPayload: EncryptedCredentialPayload;
  readonly encryptionVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Persistence boundary for encrypted credentials. It never handles plaintext. */
export interface ProviderCredentialRepository {
  save(input: Omit<StoredProviderCredential, "id" | "createdAt" | "updatedAt">): Promise<StoredProviderCredential>;
  get(userId: string, provider: ProviderCredentialProvider): Promise<StoredProviderCredential | null>;
  delete(userId: string, provider: ProviderCredentialProvider): Promise<boolean>;
}

function parsePayload(value: string): EncryptedCredentialPayload {
  const payload = JSON.parse(value) as EncryptedCredentialPayload;
  if (
    payload.version !== 1 ||
    typeof payload.nonce !== "string" ||
    typeof payload.ciphertext !== "string" ||
    typeof payload.authTag !== "string"
  ) {
    throw new Error("Stored provider credential payload is invalid");
  }
  return payload;
}

function toStoredCredential(row: {
  id: string;
  userId: string;
  provider: ProviderCredentialProvider;
  encryptedPayload: string;
  encryptionVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): StoredProviderCredential {
  return { ...row, encryptedPayload: parsePayload(row.encryptedPayload) };
}

export function createProviderCredentialRepository(
  db: Db,
): ProviderCredentialRepository {
  return {
    async save(input) {
      const now = new Date();
      const [row] = await db
        .insert(schema.providerCredential)
        .values({
          userId: input.userId,
          provider: input.provider,
          encryptedPayload: JSON.stringify(input.encryptedPayload),
          encryptionVersion: input.encryptionVersion,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.providerCredential.userId,
            schema.providerCredential.provider,
          ],
          set: {
            encryptedPayload: JSON.stringify(input.encryptedPayload),
            encryptionVersion: input.encryptionVersion,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) {
        throw new Error("Unable to save provider credential");
      }
      return toStoredCredential(row);
    },

    async get(userId, provider) {
      const [row] = await db
        .select()
        .from(schema.providerCredential)
        .where(
          and(
            eq(schema.providerCredential.userId, userId),
            eq(schema.providerCredential.provider, provider),
          ),
        )
        .limit(1);
      return row ? toStoredCredential(row) : null;
    },

    async delete(userId, provider) {
      const deleted = await db
        .delete(schema.providerCredential)
        .where(
          and(
            eq(schema.providerCredential.userId, userId),
            eq(schema.providerCredential.provider, provider),
          ),
        )
        .returning({ id: schema.providerCredential.id });
      return deleted.length === 1;
    },
  };
}
