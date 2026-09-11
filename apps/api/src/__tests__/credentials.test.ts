import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  createCredentialCipher,
  type EncryptedCredentialPayload,
} from "../credentials/crypto.js";
import type {
  ProviderCredentialRepository,
  StoredProviderCredential,
} from "../credentials/repository.js";
import { createProviderCredentialRepository } from "../credentials/repository.js";
import { createProviderCredentialService } from "../credentials/service.js";

const key = Buffer.alloc(32, 7).toString("base64");
const context = { userId: "user-a", provider: "openai" } as const;

class MemoryCredentialRepository implements ProviderCredentialRepository {
  readonly records = new Map<string, StoredProviderCredential>();

  private recordKey(userId: string, provider: string) {
    return `${userId}:${provider}`;
  }

  async save(
    input: Omit<StoredProviderCredential, "id" | "createdAt" | "updatedAt">,
  ): Promise<StoredProviderCredential> {
    const recordKey = this.recordKey(input.userId, input.provider);
    const existing = this.records.get(recordKey);
    const now = new Date();
    const saved: StoredProviderCredential = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(recordKey, saved);
    return saved;
  }

  async get(userId: string, provider: "anthropic" | "openai" | "openrouter") {
    return this.records.get(this.recordKey(userId, provider)) ?? null;
  }

  async delete(
    userId: string,
    provider: "anthropic" | "openai" | "openrouter",
  ) {
    return this.records.delete(this.recordKey(userId, provider));
  }
}

test("provider credential encryption round-trips with a randomized envelope", () => {
  const cipher = createCredentialCipher(key);
  const first = cipher.encrypt("sk-secret", context);
  const second = cipher.encrypt("sk-secret", context);

  assert.equal(cipher.decrypt(first, context), "sk-secret");
  assert.notDeepEqual(first, second);
});

test("provider credential encryption rejects tampering and a different key", () => {
  const cipher = createCredentialCipher(key);
  const encrypted = cipher.encrypt("sk-secret", context);
  const tampered: EncryptedCredentialPayload = {
    ...encrypted,
    authTag: `${encrypted.authTag[0] === "A" ? "B" : "A"}${encrypted.authTag.slice(1)}`,
  };

  assert.throws(() => cipher.decrypt(tampered, context), /Unable to decrypt/);
  assert.throws(
    () => createCredentialCipher(Buffer.alloc(32, 8).toString("base64")).decrypt(encrypted, context),
    /Unable to decrypt/,
  );
});

test("provider credential encryption rejects missing and invalid key configuration", () => {
  assert.throws(() => createCredentialCipher(null), /AI_CREDENTIAL_ENCRYPTION_KEY/);
  assert.throws(() => createCredentialCipher("not-a-32-byte-key"), /AI_CREDENTIAL_ENCRYPTION_KEY/);
});

test("database repository serializes an encrypted envelope, never the secret", async () => {
  const cipher = createCredentialCipher(key);
  const encryptedPayload = cipher.encrypt("sk-secret", context);
  let persisted: Record<string, unknown> | undefined;
  const now = new Date();
  const db = {
    insert() {
      return {
        values(values: Record<string, unknown>) {
          persisted = values;
          return {
            onConflictDoUpdate() {
              return {
                returning() {
                  return [
                    {
                      ...values,
                      id: "credential-id",
                      createdAt: now,
                      updatedAt: now,
                    },
                  ];
                },
              };
            },
          };
        },
      };
    },
  } as never;

  await createProviderCredentialRepository(db).save({
    ...context,
    encryptedPayload,
    encryptionVersion: encryptedPayload.version,
  });

  const persistedJson = JSON.stringify(persisted);
  assert.ok(persistedJson);
  assert.notEqual(persistedJson, "sk-secret");
  assert.equal(persistedJson.includes("sk-secret"), false);
});

test("credential service stores only encrypted payloads and scopes every lookup by user", async () => {
  const repository = new MemoryCredentialRepository();
  const service = createProviderCredentialService(
    repository,
    createCredentialCipher(key),
  );

  const metadata = await service.save({ ...context, secret: "sk-secret" });
  const stored = [...repository.records.values()][0]!;

  assert.equal(repository.records.size, 1);
  assert.notEqual(JSON.stringify(stored.encryptedPayload), "sk-secret");
  assert.equal("encryptedPayload" in metadata, false);
  assert.equal("secret" in metadata, false);
  assert.equal("nonce" in metadata, false);
  assert.equal("authTag" in metadata, false);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "connected",
    "createdAt",
    "id",
    "provider",
    "updatedAt",
  ]);
  assert.equal(await service.getSecret(context), "sk-secret");
  assert.equal(
    await service.getSecret({ userId: "user-b", provider: "openai" }),
    null,
  );
});

test("credential service upserts one credential per user and provider", async () => {
  const repository = new MemoryCredentialRepository();
  const service = createProviderCredentialService(
    repository,
    createCredentialCipher(key),
  );

  const first = await service.save({ ...context, secret: "sk-old" });
  const second = await service.save({ ...context, secret: "sk-new" });

  assert.equal(repository.records.size, 1);
  assert.equal(first.id, second.id);
  assert.equal(await service.getSecret(context), "sk-new");
});
