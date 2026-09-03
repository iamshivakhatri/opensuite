import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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

/**
 * Office formats OpenSuite stores. Matches `@opensuite/contracts` DocumentFormat
 * values but lives here so `packages/db` stays independent of contracts.
 */
export const documentFormatEnum = pgEnum("document_format", [
  "docx",
  "pptx",
  "xlsx",
]);

/**
 * Who produced a document version snapshot.
 */
export const documentVersionSourceEnum = pgEnum("document_version_source", [
  "upload",
  "user",
  "agent",
  "system",
]);

/**
 * Top-level product container owned by one user.
 * Soft-deleted via `deleted_at`. Hard deletion is an explicit product workflow
 * later — FKs use `restrict` so history cannot be silently cascade-removed.
 */
export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("workspace_owner_user_id_idx").on(table.ownerUserId)],
);

/**
 * A document belonging to a workspace. Soft-deleted via `deleted_at`.
 * There is no `current_version_id` — the latest version is the row with the
 * highest `document_version.version_number` for this document.
 */
export const document = pgTable(
  "document",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    format: documentFormatEnum("format").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("document_workspace_id_idx").on(table.workspaceId)],
);

/**
 * Immutable snapshot of a document's bytes in object storage.
 * `storage_key` is an object-storage key, never a MinIO/S3 URL.
 */
export const documentVersion = pgTable(
  "document_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    parentVersionId: uuid("parent_version_id").references(
      (): AnyPgColumn => documentVersion.id,
      { onDelete: "restrict" },
    ),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    source: documentVersionSourceEnum("source").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("document_version_document_id_version_number_uidx").on(
      table.documentId,
      table.versionNumber,
    ),
    check(
      "document_version_version_number_positive",
      sql`${table.versionNumber} > 0`,
    ),
  ],
);

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  owner: one(user, {
    fields: [workspace.ownerUserId],
    references: [user.id],
  }),
  documents: many(document),
}));

export const documentRelations = relations(document, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [document.workspaceId],
    references: [workspace.id],
  }),
  versions: many(documentVersion),
}));

export const documentVersionRelations = relations(
  documentVersion,
  ({ one }) => ({
    document: one(document, {
      fields: [documentVersion.documentId],
      references: [document.id],
    }),
    parentVersion: one(documentVersion, {
      fields: [documentVersion.parentVersionId],
      references: [documentVersion.id],
      relationName: "documentVersionParent",
    }),
    createdBy: one(user, {
      fields: [documentVersion.createdByUserId],
      references: [user.id],
    }),
  }),
);
