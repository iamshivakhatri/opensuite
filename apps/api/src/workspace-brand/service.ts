import { eq } from "drizzle-orm";
import { schema, type Db } from "@opensuite/db";
import type { WorkspaceBrandData, WorkspaceBrandProfile } from "@opensuite/contracts";
import type { WorkspaceAssetService } from "./assets.js";

function toProfile(row: typeof schema.workspaceBrand.$inferSelect): WorkspaceBrandProfile {
  const data = row.data as Omit<WorkspaceBrandData, "logoAssetId">;
  // Old development rows may contain document preferences; expose only identity fields.
  return {
    schemaVersion: data.schemaVersion,
    organization: data.organization,
    colors: data.colors,
    typography: data.typography,
    logoAssetId: row.logoAssetId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function createWorkspaceBrandService(db: Db, assets: WorkspaceAssetService) {
  return {
    async get(workspaceId: string, userId: string): Promise<WorkspaceBrandProfile | null> {
      await assets.requireWorkspace(workspaceId, userId);
      const [row] = await db
        .select()
        .from(schema.workspaceBrand)
        .where(eq(schema.workspaceBrand.workspaceId, workspaceId))
        .limit(1);
      return row ? toProfile(row) : null;
    },
    async save(
      workspaceId: string,
      userId: string,
      input: WorkspaceBrandData,
    ): Promise<WorkspaceBrandProfile> {
      const { logoAssetId, ...data } = input;
      const saved = await db.transaction(async (tx) => {
        await assets.lockWorkspace(tx, workspaceId, userId);
        if (logoAssetId) await assets.requireAsset(workspaceId, logoAssetId, tx);
        const [previous] = await tx
          .select()
          .from(schema.workspaceBrand)
          .where(eq(schema.workspaceBrand.workspaceId, workspaceId))
          .limit(1);
        const [row] = await tx
          .insert(schema.workspaceBrand)
          .values({ workspaceId, logoAssetId, data })
          .onConflictDoUpdate({
            target: schema.workspaceBrand.workspaceId,
            set: { data, logoAssetId, updatedAt: new Date() },
          })
          .returning();
        if (!row) throw new Error("Could not save workspace brand");
        return { profile: toProfile(row), previousLogo: previous?.logoAssetId };
      });
      if (saved.previousLogo && saved.previousLogo !== logoAssetId) {
        await assets
          .removeUnused(workspaceId, userId, saved.previousLogo)
          .catch((error) => console.error("[workspace-brand] old logo cleanup failed", error));
      }
      return saved.profile;
    },
  };
}
export type WorkspaceBrandService = ReturnType<typeof createWorkspaceBrandService>;
