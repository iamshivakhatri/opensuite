import { index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

/** AI providers that OpenSuite can currently configure for its agent. */
export const providerCredentialProviderEnum = pgEnum("provider_credential_provider", [
  "anthropic",
  "openai",
  "openrouter",
]);

/**
 * One encrypted API credential per user and provider. The payload is an
 * application-owned versioned envelope; it is never returned by public APIs.
 */
export const providerCredential = pgTable(
  "provider_credential",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: providerCredentialProviderEnum("provider").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("provider_credential_user_id_provider_uidx").on(
      table.userId,
      table.provider,
    ),
    index("provider_credential_user_id_idx").on(table.userId),
  ],
);
