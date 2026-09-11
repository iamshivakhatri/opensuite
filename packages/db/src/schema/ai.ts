import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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

export const aiCredentialSourceEnum = pgEnum("ai_credential_source", [
  "byok",
  "managed",
]);

/** One active model choice per user; credentials remain in provider_credential. */
export const aiPreference = pgTable("ai_preference", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: providerCredentialProviderEnum("provider").notNull(),
  model: text("model").notNull(),
  credentialSource: aiCredentialSourceEnum("credential_source").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * Append-only ledger of completed model provider requests.
 * Independent of agent_run / agent_step accounting; agent_run_id is correlation only.
 * Token fields are nullable — omit when the provider did not report them (never invent 0).
 */
export const modelUsageEvent = pgTable(
  "model_usage_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: providerCredentialProviderEnum("provider").notNull(),
    model: text("model").notNull(),
    credentialSource: aiCredentialSourceEnum("credential_source").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    /** Optional correlation to an agent run; not required for accounting. */
    agentRunId: uuid("agent_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("model_usage_event_user_id_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("model_usage_event_agent_run_id_idx").on(table.agentRunId),
    check(
      "model_usage_event_input_tokens_nonneg",
      sql`${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0`,
    ),
    check(
      "model_usage_event_output_tokens_nonneg",
      sql`${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0`,
    ),
    check(
      "model_usage_event_cached_input_tokens_nonneg",
      sql`${table.cachedInputTokens} IS NULL OR ${table.cachedInputTokens} >= 0`,
    ),
    check(
      "model_usage_event_reasoning_tokens_nonneg",
      sql`${table.reasoningTokens} IS NULL OR ${table.reasoningTokens} >= 0`,
    ),
  ],
);
