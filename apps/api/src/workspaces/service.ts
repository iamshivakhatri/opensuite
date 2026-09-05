import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { OfficeFormat } from "../documents/format.js";

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
export function createWorkspaceService(db: Db) {
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
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
