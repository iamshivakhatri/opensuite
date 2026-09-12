import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { OfficeFormat } from "../documents/format.js";
import { ObjectNotFoundError, type ObjectStorage } from "../storage/types.js";
import type { StorageAccountingService } from "../storage-accounting/service.js";

/**
 * OpenSuite-owned workspace shape returned by product API routes.
 * Deliberately omits soft-delete internals and raw DB row noise.
 */
export interface WorkspaceDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRecentDocumentDto {
  readonly id: string;
  readonly name: string;
  readonly format: OfficeFormat;
}

/**
 * Workspace list card payload — enough for /app home without N+1.
 */
export interface WorkspaceSummaryDto extends WorkspaceDto {
  readonly documentCount: number;
  readonly recentDocuments: readonly WorkspaceRecentDocumentDto[];
}

function toWorkspaceDto(row: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDto {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Small workspace data-access helpers for the API. Ownership is always
 * scoped by `ownerUserId` — never taken from the client body.
 */
export type WorkspaceAccessErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_IN_TRASH"
  | "PURGE_FAILED";

export class WorkspaceAccessError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: WorkspaceAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export function createWorkspaceService(
  db: Db,
  storage: ObjectStorage,
  storageAccounting: StorageAccountingService,
) {
  return {
    /**
     * Returns the workspace only when it is owned by `ownerUserId` and not
     * soft-deleted. Used to authorize nested product actions (e.g. upload).
     */
    async getOwned(
      workspaceId: string,
      ownerUserId: string,
    ): Promise<WorkspaceDto | null> {
      const [row] = await db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
        })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.id, workspaceId),
            eq(schema.workspace.ownerUserId, ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .limit(1);

      return row ? toWorkspaceDto(row) : null;
    },

    async listOwned(ownerUserId: string): Promise<WorkspaceDto[]> {
      const rows = await db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
        })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.ownerUserId, ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(
          desc(schema.workspace.updatedAt),
          desc(schema.workspace.createdAt),
        );

      return rows.map(toWorkspaceDto);
    },

    /**
     * Owned workspaces with document counts + a few recent filenames.
     * Two queries total (not N+1).
     */
    async listOwnedSummaries(
      ownerUserId: string,
    ): Promise<WorkspaceSummaryDto[]> {
      const workspaces = await this.listOwned(ownerUserId);
      if (workspaces.length === 0) {
        return [];
      }

      const workspaceIds = workspaces.map((workspace) => workspace.id);
      const docs = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          name: schema.document.name,
          format: schema.document.format,
          updatedAt: schema.document.updatedAt,
        })
        .from(schema.document)
        .where(
          and(
            inArray(schema.document.workspaceId, workspaceIds),
            isNull(schema.document.deletedAt),
          ),
        )
        .orderBy(
          desc(schema.document.updatedAt),
          desc(schema.document.createdAt),
        );

      const byWorkspace = new Map<
        string,
        {
          count: number;
          recent: WorkspaceRecentDocumentDto[];
        }
      >();

      for (const doc of docs) {
        const bucket = byWorkspace.get(doc.workspaceId) ?? {
          count: 0,
          recent: [],
        };
        bucket.count += 1;
        if (bucket.recent.length < 3) {
          bucket.recent.push({
            id: doc.id,
            name: doc.name,
            format: doc.format,
          });
        }
        byWorkspace.set(doc.workspaceId, bucket);
      }

      return workspaces.map((workspace) => {
        const bucket = byWorkspace.get(workspace.id);
        return {
          ...workspace,
          documentCount: bucket?.count ?? 0,
          recentDocuments: bucket?.recent ?? [],
        };
      });
    },

    async create(input: {
      ownerUserId: string;
      name: string;
    }): Promise<WorkspaceDto> {
      const [row] = await db
        .insert(schema.workspace)
        .values({
          ownerUserId: input.ownerUserId,
          name: input.name,
        })
        .returning({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
        });

      if (!row) {
        throw new Error("Failed to create workspace");
      }

      return toWorkspaceDto(row);
    },

    async rename(input: {
      workspaceId: string;
      ownerUserId: string;
      name: string;
    }): Promise<WorkspaceDto | null> {
      const [row] = await db
        .update(schema.workspace)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.workspace.id, input.workspaceId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .returning({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
        });

      return row ? toWorkspaceDto(row) : null;
    },

    /**
     * Soft-deletes an owned workspace. Document/version history is retained.
     * Soft-deleted workspaces disappear from lists and normal access paths.
     */
    async softDelete(input: {
      workspaceId: string;
      ownerUserId: string;
    }): Promise<boolean> {
      const [row] = await db
        .update(schema.workspace)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.workspace.id, input.workspaceId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .returning({ id: schema.workspace.id });

      return Boolean(row);
    },

    /**
     * Restores a soft-deleted workspace. Nested documents keep their own
     * deletedAt — only previously active docs become accessible again.
     */
    async restore(input: {
      workspaceId: string;
      ownerUserId: string;
    }): Promise<WorkspaceDto | null> {
      const [row] = await db
        .update(schema.workspace)
        .set({
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.workspace.id, input.workspaceId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNotNull(schema.workspace.deletedAt),
          ),
        )
        .returning({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
        });

      return row ? toWorkspaceDto(row) : null;
    },

    /**
     * Deletes a trashed workspace's object bytes first, then atomically
     * removes its product rows and releases their recorded version bytes.
     * Missing objects are a safe retry after a previous partial purge.
     */
    async purge(input: {
      workspaceId: string;
      ownerUserId: string;
    }): Promise<void> {
      try {
        await db.transaction(async (tx) => {
          const locked = await tx.execute(sql`
            select ${schema.workspace.id}
            from ${schema.workspace}
            where ${schema.workspace.id} = ${input.workspaceId}
              and ${schema.workspace.ownerUserId} = ${input.ownerUserId}
            for update
          `);
          if (locked.rows.length === 0) {
            throw new WorkspaceAccessError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
          }

          const [workspace] = await tx
            .select({ deletedAt: schema.workspace.deletedAt })
            .from(schema.workspace)
            .where(eq(schema.workspace.id, input.workspaceId))
            .limit(1);
          if (workspace?.deletedAt == null) {
            throw new WorkspaceAccessError(
              409,
              "WORKSPACE_NOT_IN_TRASH",
              "Move the workspace to Trash before permanently deleting it",
            );
          }

          // Locks serialize child document purge and preserve this exact byte set.
          await tx.execute(sql`
            select ${schema.document.id}
            from ${schema.document}
            where ${schema.document.workspaceId} = ${input.workspaceId}
            for update
          `);
          const versions = await tx
            .select({
              storageKey: schema.documentVersion.storageKey,
              sizeBytes: schema.documentVersion.sizeBytes,
            })
            .from(schema.documentVersion)
            .innerJoin(
              schema.document,
              eq(schema.documentVersion.documentId, schema.document.id),
            )
            .where(eq(schema.document.workspaceId, input.workspaceId));
          const reclaimedBytes = versions.reduce(
            (total, version) => total + version.sizeBytes,
            0,
          );

          for (const version of versions) {
            try {
              await storage.deleteObject(version.storageKey);
            } catch (error) {
              if (!(error instanceof ObjectNotFoundError)) throw error;
            }
          }

          const threadIds = tx
            .select({ id: schema.agentThread.id })
            .from(schema.agentThread)
            .where(eq(schema.agentThread.workspaceId, input.workspaceId));
          const runIds = tx
            .select({ id: schema.agentRun.id })
            .from(schema.agentRun)
            .where(sql`${schema.agentRun.threadId} in (${threadIds})`);

          await tx.delete(schema.agentStep).where(sql`${schema.agentStep.runId} in (${runIds})`);
          await tx.delete(schema.agentRun).where(sql`${schema.agentRun.threadId} in (${threadIds})`);
          await tx.delete(schema.agentMessage).where(sql`${schema.agentMessage.threadId} in (${threadIds})`);
          await tx.delete(schema.agentThread).where(eq(schema.agentThread.workspaceId, input.workspaceId));
          await tx.delete(schema.documentUserState).where(sql`${schema.documentUserState.documentId} in (
            select ${schema.document.id} from ${schema.document}
            where ${schema.document.workspaceId} = ${input.workspaceId}
          )`);
          await tx.update(schema.documentVersion).set({ parentVersionId: null }).where(sql`${schema.documentVersion.documentId} in (
            select ${schema.document.id} from ${schema.document}
            where ${schema.document.workspaceId} = ${input.workspaceId}
          )`);
          await tx.delete(schema.documentVersion).where(sql`${schema.documentVersion.documentId} in (
            select ${schema.document.id} from ${schema.document}
            where ${schema.document.workspaceId} = ${input.workspaceId}
          )`);
          await tx.delete(schema.document).where(eq(schema.document.workspaceId, input.workspaceId));
          await tx.delete(schema.workspace).where(eq(schema.workspace.id, input.workspaceId));
          if (reclaimedBytes > 0) {
            await storageAccounting.release(tx, input.ownerUserId, reclaimedBytes);
          }
        });
      } catch (error) {
        if (error instanceof WorkspaceAccessError) throw error;
        throw new WorkspaceAccessError(500, "PURGE_FAILED", "Could not permanently delete workspace");
      }
    },

    async listTrash(ownerUserId: string): Promise<
      Array<
        WorkspaceDto & {
          readonly deletedAt: string;
        }
      >
    > {
      const rows = await db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          createdAt: schema.workspace.createdAt,
          updatedAt: schema.workspace.updatedAt,
          deletedAt: schema.workspace.deletedAt,
        })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.ownerUserId, ownerUserId),
            isNotNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(desc(schema.workspace.deletedAt));

      return rows
        .filter((row) => row.deletedAt != null)
        .map((row) => ({
          ...toWorkspaceDto(row),
          deletedAt: row.deletedAt!.toISOString(),
        }));
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
