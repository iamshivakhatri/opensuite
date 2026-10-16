import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { agentMessage, agentThread } from "./agent.js";
import { workspace } from "./product.js";

/**
 * Chat-scoped file (or future text) resource. Not a workspace document.
 * staged = uploaded, not yet claimed by a message; bound = linked to a message;
 * deleted = bytes removed, row retained so message IDs stay meaningful.
 */
export const chatAttachmentStatusEnum = pgEnum("chat_attachment_status", [
  "staged",
  "bound",
  "deleted",
]);

/** Distinguishes binary uploads from future staged large-prompt text resources. */
export const chatAttachmentKindEnum = pgEnum("chat_attachment_kind", [
  "file",
  "text",
]);

export const chatAttachment = pgTable(
  "chat_attachment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    threadId: uuid("thread_id").references(() => agentThread.id, {
      onDelete: "restrict",
    }),
    messageId: uuid("message_id").references(() => agentMessage.id, {
      onDelete: "restrict",
    }),
    kind: chatAttachmentKindEnum("kind").notNull().default("file"),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    status: chatAttachmentStatusEnum("status").notNull().default("staged"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    boundAt: timestamp("bound_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("chat_attachment_workspace_owner_idx").on(
      table.workspaceId,
      table.ownerUserId,
    ),
    index("chat_attachment_thread_idx").on(table.threadId),
    index("chat_attachment_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);
