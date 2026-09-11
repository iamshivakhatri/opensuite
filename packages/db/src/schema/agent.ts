import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { document, documentVersion, workspace } from "./product.js";

/**
 * User-visible conversation roles only. System prompts and tool calls are not
 * stored as messages — those belong to agent_run / agent_step.
 */
export const agentMessageRoleEnum = pgEnum("agent_message_role", [
  "user",
  "assistant",
]);

/**
 * Lifecycle of one durable agent execution attempt.
 * Kept small on purpose — orchestration lives in application services later.
 */
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "planning",
  "running",
  "waiting_for_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Application-level step kinds (not Rust ops, not provider tool names).
 */
export const agentStepKindEnum = pgEnum("agent_step_kind", [
  "plan",
  "inspect",
  "tool",
  "confirmation",
  "validation",
  "final",
]);

export const agentStepStatusEnum = pgEnum("agent_step_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Conversation container. Always workspace-scoped; optionally document-scoped.
 * Soft-archived via `archived_at` — conversation history is not hard-deleted.
 *
 * FK deletion (deliberate, matches product history posture):
 * - workspace_id: RESTRICT (soft-delete workspace; do not cascade-wipe threads)
 * - (document_id, workspace_id) → document(id, workspace_id): RESTRICT when
 *   document_id is set; NULLs skip the check. Blocks document hard-delete while
 *   document-scoped threads still reference it. Same-workspace invariant is
 *   enforced by this composite FK (also re-checked in the persistence service).
 * - created_by_user_id: SET NULL (attribution may fade; history remains)
 */
export const agentThread = pgTable(
  "agent_thread",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    documentId: uuid("document_id"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.workspaceId],
      foreignColumns: [document.id, document.workspaceId],
      name: "agent_thread_document_workspace_fk",
    }).onDelete("restrict"),
    index("agent_thread_workspace_id_idx").on(table.workspaceId),
    index("agent_thread_document_id_idx").on(table.documentId),
    index("agent_thread_workspace_id_updated_at_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
  ],
);

/**
 * Immutable user-visible conversation turn. Ordering: created_at, then id.
 */
export const agentMessage = pgTable(
  "agent_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => agentThread.id, { onDelete: "restrict" }),
    role: agentMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_message_thread_id_created_at_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

/**
 * One durable attempt to execute an agent request (independent of HTTP).
 * `base_document_version_id` is provenance only: the exact document_version
 * the run resolved at start (null for workspace-only / non-document runs).
 */
export const agentRun = pgTable(
  "agent_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => agentThread.id, { onDelete: "restrict" }),
    triggeringMessageId: uuid("triggering_message_id").references(
      () => agentMessage.id,
      { onDelete: "set null" },
    ),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    baseDocumentVersionId: uuid("base_document_version_id").references(
      () => documentVersion.id,
      { onDelete: "restrict" },
    ),
    status: agentRunStatusEnum("status").notNull().default("queued"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [index("agent_run_thread_id_idx").on(table.threadId)],
);

/**
 * Database-backed ownership of a user's currently executing agent run.
 * It is coordination data only; agent_run and model_usage_event keep their
 * independent lifecycle and accounting roles.
 */
export const agentExecutionLease = pgTable(
  "agent_execution_lease",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    leaseId: uuid("lease_id").notNull().unique(),
    acquiredAt: timestamp("acquired_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("agent_execution_lease_expires_at_idx").on(table.expiresAt)],
);

/**
 * Ordered unit of work within a run. input/output are application-owned JSON
 * only — never raw chain-of-thought or engine/provider internals.
 */
export const agentStep = pgTable(
  "agent_step",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRun.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    kind: agentStepKindEnum("kind").notNull(),
    status: agentStepStatusEnum("status").notNull().default("pending"),
    name: text("name").notNull(),
    summary: text("summary"),
    input: jsonb("input").$type<Record<string, unknown> | null>(),
    output: jsonb("output").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    unique("agent_step_run_id_sequence_uidx").on(table.runId, table.sequence),
    check("agent_step_sequence_non_negative", sql`${table.sequence} >= 0`),
    index("agent_step_run_id_sequence_idx").on(table.runId, table.sequence),
  ],
);

export const agentThreadRelations = relations(agentThread, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [agentThread.workspaceId],
    references: [workspace.id],
  }),
  document: one(document, {
    fields: [agentThread.documentId],
    references: [document.id],
  }),
  createdBy: one(user, {
    fields: [agentThread.createdByUserId],
    references: [user.id],
  }),
  messages: many(agentMessage),
  runs: many(agentRun),
}));

export const agentMessageRelations = relations(agentMessage, ({ one }) => ({
  thread: one(agentThread, {
    fields: [agentMessage.threadId],
    references: [agentThread.id],
  }),
}));

export const agentRunRelations = relations(agentRun, ({ one, many }) => ({
  thread: one(agentThread, {
    fields: [agentRun.threadId],
    references: [agentThread.id],
  }),
  triggeringMessage: one(agentMessage, {
    fields: [agentRun.triggeringMessageId],
    references: [agentMessage.id],
  }),
  createdBy: one(user, {
    fields: [agentRun.createdByUserId],
    references: [user.id],
  }),
  baseDocumentVersion: one(documentVersion, {
    fields: [agentRun.baseDocumentVersionId],
    references: [documentVersion.id],
  }),
  steps: many(agentStep),
}));

export const agentStepRelations = relations(agentStep, ({ one }) => ({
  run: one(agentRun, {
    fields: [agentStep.runId],
    references: [agentRun.id],
  }),
}));
