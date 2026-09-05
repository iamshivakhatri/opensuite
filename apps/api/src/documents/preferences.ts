import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { OfficeFormat } from "./format.js";
import { DocumentAccessError } from "./service.js";

export interface LibraryDocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
  readonly starred: boolean;
  readonly starredAt: string | null;
}

/**
 * Per-user document prefs: last-opened + star. Always ownership-checked via
 * workspace join so deleted/non-owned docs never leak.
 */
export function createDocumentPreferenceService(db: Db) {
  async function assertOwnedDocument(input: {
    documentId: string;
    ownerUserId: string;
  }): Promise<{ documentId: string }> {
    const [row] = await db
      .select({ id: schema.document.id })
      .from(schema.document)
      .innerJoin(
        schema.workspace,
        eq(schema.document.workspaceId, schema.workspace.id),
      )
      .where(
        and(
          eq(schema.document.id, input.documentId),
          eq(schema.workspace.ownerUserId, input.ownerUserId),
          isNull(schema.document.deletedAt),
          isNull(schema.workspace.deletedAt),
        ),
      )
      .limit(1);

    if (!row) {
      throw new DocumentAccessError(
        404,
        "DOCUMENT_NOT_FOUND",
        "Document not found",
      );
    }

    return { documentId: row.id };
  }

  return {
    async recordOpened(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<void> {
      await assertOwnedDocument(input);
      const now = new Date();
      await db
        .insert(schema.documentUserState)
        .values({
          userId: input.ownerUserId,
          documentId: input.documentId,
          lastOpenedAt: now,
          starred: false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.documentUserState.userId,
            schema.documentUserState.documentId,
          ],
          set: {
            lastOpenedAt: now,
            updatedAt: now,
          },
        });
    },

    async setStarred(input: {
      documentId: string;
      ownerUserId: string;
      starred: boolean;
    }): Promise<{ starred: boolean; starredAt: string | null }> {
      await assertOwnedDocument(input);
      const now = new Date();
      const starredAt = input.starred ? now : null;

      await db
        .insert(schema.documentUserState)
        .values({
          userId: input.ownerUserId,
          documentId: input.documentId,
          starred: input.starred,
          starredAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.documentUserState.userId,
            schema.documentUserState.documentId,
          ],
          set: {
            starred: input.starred,
            starredAt,
            updatedAt: now,
          },
        });

      return {
        starred: input.starred,
        starredAt: starredAt?.toISOString() ?? null,
      };
    },

    async listRecent(ownerUserId: string): Promise<LibraryDocumentDto[]> {
      const rows = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceName: schema.workspace.name,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          lastOpenedAt: schema.documentUserState.lastOpenedAt,
          starred: schema.documentUserState.starred,
          starredAt: schema.documentUserState.starredAt,
        })
        .from(schema.documentUserState)
        .innerJoin(
          schema.document,
          eq(schema.documentUserState.documentId, schema.document.id),
        )
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .where(
          and(
            eq(schema.documentUserState.userId, ownerUserId),
            eq(schema.workspace.ownerUserId, ownerUserId),
            isNotNull(schema.documentUserState.lastOpenedAt),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(desc(schema.documentUserState.lastOpenedAt))
        .limit(50);

      return rows.map(toLibraryDto);
    },

    async listStarred(ownerUserId: string): Promise<LibraryDocumentDto[]> {
      const rows = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceName: schema.workspace.name,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          lastOpenedAt: schema.documentUserState.lastOpenedAt,
          starred: schema.documentUserState.starred,
          starredAt: schema.documentUserState.starredAt,
        })
        .from(schema.documentUserState)
        .innerJoin(
          schema.document,
          eq(schema.documentUserState.documentId, schema.document.id),
        )
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .where(
          and(
            eq(schema.documentUserState.userId, ownerUserId),
            eq(schema.workspace.ownerUserId, ownerUserId),
            eq(schema.documentUserState.starred, true),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(
          desc(schema.documentUserState.starredAt),
          desc(schema.document.updatedAt),
        )
        .limit(100);

      return rows.map(toLibraryDto);
    },

    async listByFormat(input: {
      ownerUserId: string;
      format: OfficeFormat;
    }): Promise<LibraryDocumentDto[]> {
      const rows = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceName: schema.workspace.name,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          lastOpenedAt: schema.documentUserState.lastOpenedAt,
          starred: schema.documentUserState.starred,
          starredAt: schema.documentUserState.starredAt,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .leftJoin(
          schema.documentUserState,
          and(
            eq(schema.documentUserState.documentId, schema.document.id),
            eq(schema.documentUserState.userId, input.ownerUserId),
          ),
        )
        .where(
          and(
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            eq(schema.document.format, input.format),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(
          desc(schema.document.updatedAt),
          desc(schema.document.createdAt),
        );

      return rows.map((row) =>
        toLibraryDto({
          ...row,
          starred: row.starred ?? false,
          starredAt: row.starredAt,
          lastOpenedAt: row.lastOpenedAt,
        }),
      );
    },

    async getStarState(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<{ starred: boolean }> {
      const [row] = await db
        .select({ starred: schema.documentUserState.starred })
        .from(schema.documentUserState)
        .where(
          and(
            eq(schema.documentUserState.userId, input.ownerUserId),
            eq(schema.documentUserState.documentId, input.documentId),
          ),
        )
        .limit(1);

      return { starred: row?.starred ?? false };
    },
  };
}

function toLibraryDto(row: {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  format: OfficeFormat;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date | null;
  starred: boolean;
  starredAt: Date | null;
}): LibraryDocumentDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    name: row.name,
    format: row.format,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    starred: row.starred,
    starredAt: row.starredAt?.toISOString() ?? null,
  };
}

export type DocumentPreferenceService = ReturnType<
  typeof createDocumentPreferenceService
>;
