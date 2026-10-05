import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@opensuite/db";
import type { WorkspaceService } from "../workspaces/service.js";
import { WorkspaceAccessError } from "../workspaces/service.js";
import { ObjectNotFoundError, type ObjectStorage } from "../storage/types.js";
import type { StorageAccountingService } from "../storage-accounting/service.js";
import { assetMaxBytes } from "./validation.js";
import { optimizeWorkspaceImage } from "./images.js";

/** Engine picture ops accept only these stored MIME types. */
export const ENGINE_IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg"] as const;
export type EngineImageContentType = (typeof ENGINE_IMAGE_CONTENT_TYPES)[number];

export class WorkspaceAssetError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createWorkspaceAssetService(
  db: Db,
  storage: ObjectStorage,
  workspaces: Pick<WorkspaceService, "getOwned">,
  accounting: StorageAccountingService,
) {
  async function requireWorkspace(workspaceId: string, userId: string) {
    if (!(await workspaces.getOwned(workspaceId, userId)))
      throw new WorkspaceAccessError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }
  async function lockWorkspace(tx: Db, workspaceId: string, userId: string) {
    // Reuse the existing access rule after taking the lock; purge uses this lock too.
    await tx.execute(sql`select id from ${schema.workspace} where id = ${workspaceId} for update`);
    await requireWorkspace(workspaceId, userId);
  }
  const owned = (workspaceId: string, id: string) =>
    and(eq(schema.workspaceAsset.workspaceId, workspaceId), eq(schema.workspaceAsset.id, id));
  return {
    requireWorkspace,
    lockWorkspace,
    async requireAsset(workspaceId: string, id: string, tx: Db = db) {
      const [asset] = await tx
        .select()
        .from(schema.workspaceAsset)
        .where(owned(workspaceId, id))
        .limit(1);
      if (!asset)
        throw new WorkspaceAssetError(404, "ASSET_NOT_FOUND", "Workspace image not found");
      return asset;
    },
    async upload(workspaceId: string, userId: string, bytes: Buffer) {
      await requireWorkspace(workspaceId, userId);
      if (bytes.length > assetMaxBytes)
        throw new WorkspaceAssetError(
          400,
          "INVALID_IMAGE",
          "Use a PNG, JPEG, or WebP image up to 2 MB",
        );
      const optimized = await optimizeWorkspaceImage(bytes).catch(() => {
        throw new WorkspaceAssetError(
          400,
          "INVALID_IMAGE",
          "Use a valid PNG, JPEG, or WebP image up to 2 MB",
        );
      });
      const { contentType, width, height, originalSizeBytes } = optimized;
      const id = randomUUID();
      const storageKey = `workspaces/${workspaceId}/assets/${id}`;
      try {
        await storage.putObject({ key: storageKey, body: optimized.bytes, contentType });
        await db.transaction(async (tx) => {
          await lockWorkspace(tx, workspaceId, userId);
          await accounting.reserve(tx, userId, optimized.bytes.length);
          await tx.insert(schema.workspaceAsset).values({
            id,
            workspaceId,
            storageKey,
            contentType,
            sizeBytes: optimized.bytes.length,
            width,
            height,
            originalSizeBytes,
          });
        });
      } catch (error) {
        await storage
          .deleteObject(storageKey)
          .catch((cleanupError) =>
            console.error("[workspace-assets] upload cleanup failed", cleanupError),
          );
        throw error;
      }
      return { id };
    },
    async read(workspaceId: string, userId: string, id: string) {
      await requireWorkspace(workspaceId, userId);
      const asset = await this.requireAsset(workspaceId, id);
      try {
        return {
          ...(await storage.getObject(asset.storageKey)),
          contentType: asset.contentType,
        };
      } catch (error) {
        if (error instanceof ObjectNotFoundError)
          throw new WorkspaceAssetError(404, "ASSET_NOT_FOUND", "Workspace image not found");
        throw error;
      }
    },
    async readBytes(workspaceId: string, userId: string, id: string) {
      const object = await this.read(workspaceId, userId, id);
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
      return { bytes: Buffer.concat(chunks), contentType: object.contentType };
    },
    /** Compact metadata for agent-usable PNG/JPEG assets. Never returns bytes. */
    async listImages(
      workspaceId: string,
      userId: string,
      options: { offset?: number; limit?: number } = {},
    ) {
      await requireWorkspace(workspaceId, userId);
      const limit = Math.min(50, Math.max(1, options.limit ?? 20));
      const offset = Math.max(0, options.offset ?? 0);
      const items = await db
        .select({
          id: schema.workspaceAsset.id,
          contentType: schema.workspaceAsset.contentType,
          width: schema.workspaceAsset.width,
          height: schema.workspaceAsset.height,
          sizeBytes: schema.workspaceAsset.sizeBytes,
          createdAt: schema.workspaceAsset.createdAt,
        })
        .from(schema.workspaceAsset)
        .where(
          and(
            eq(schema.workspaceAsset.workspaceId, workspaceId),
            inArray(schema.workspaceAsset.contentType, [...ENGINE_IMAGE_CONTENT_TYPES]),
          ),
        )
        .orderBy(desc(schema.workspaceAsset.createdAt))
        .limit(limit)
        .offset(offset);
      return {
        items: items.map((item) => ({
          assetId: item.id,
          contentType: item.contentType,
          width: item.width,
          height: item.height,
          sizeBytes: item.sizeBytes,
          createdAt: item.createdAt.toISOString(),
        })),
        offset,
        limit,
      };
    },
    async removeUnused(workspaceId: string, userId: string, id: string) {
      await requireWorkspace(workspaceId, userId);
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId, userId);
        const asset = await this.requireAsset(workspaceId, id, tx);
        const [reference] = await tx
          .select()
          .from(schema.workspaceBrand)
          .where(eq(schema.workspaceBrand.logoAssetId, id))
          .limit(1);
        if (reference) return;
        try {
          await storage.deleteObject(asset.storageKey);
        } catch (error) {
          if (!(error instanceof ObjectNotFoundError)) throw error;
        }
        await tx.delete(schema.workspaceAsset).where(owned(workspaceId, id));
        await accounting.release(tx, userId, asset.sizeBytes);
      });
    },
  };
}
export type WorkspaceAssetService = ReturnType<typeof createWorkspaceAssetService>;
