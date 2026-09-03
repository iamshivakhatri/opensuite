import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

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
 * Small workspace data-access helpers for the API. Not a generic repository —
 * just the two queries this milestone needs, scoped by owner.
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
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
