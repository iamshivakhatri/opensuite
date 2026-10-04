import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./product.js";

export const workspaceAsset = pgTable(
  "workspace_asset",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    originalSizeBytes: bigint("original_size_bytes", { mode: "number" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("workspace_asset_workspace_idx").on(table.workspaceId)],
);

export const workspaceBrand = pgTable("workspace_brand", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  logoAssetId: uuid("logo_asset_id").references(() => workspaceAsset.id, {
    onDelete: "restrict",
  }),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
