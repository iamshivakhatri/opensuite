import { eq } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { ProviderCredentialProvider } from "../credentials/types.js";
import type { AiPreference, CredentialSource } from "./types.js";

function toPreference(row: {
  provider: ProviderCredentialProvider;
  model: string;
  credentialSource: CredentialSource;
  createdAt: Date;
  updatedAt: Date;
}): AiPreference {
  return {
    provider: row.provider,
    model: row.model,
    credentialSource: row.credentialSource,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createAiPreferenceService(db: Db) {
  return {
    async get(userId: string): Promise<AiPreference | null> {
      const [row] = await db
        .select()
        .from(schema.aiPreference)
        .where(eq(schema.aiPreference.userId, userId))
        .limit(1);
      return row ? toPreference(row) : null;
    },

    async save(input: {
      userId: string;
      provider: ProviderCredentialProvider;
      model: string;
      credentialSource: CredentialSource;
    }): Promise<AiPreference> {
      const now = new Date();
      const [row] = await db
        .insert(schema.aiPreference)
        .values({ ...input, model: input.model.trim(), updatedAt: now })
        .onConflictDoUpdate({
          target: schema.aiPreference.userId,
          set: {
            provider: input.provider,
            model: input.model.trim(),
            credentialSource: input.credentialSource,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) throw new Error("Unable to save AI preference");
      return toPreference(row);
    },
  };
}

export type AiPreferenceService = ReturnType<typeof createAiPreferenceService>;
