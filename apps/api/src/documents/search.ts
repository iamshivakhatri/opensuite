import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { OfficeFormat } from "./format.js";

export interface SearchDocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly updatedAt: string;
  /** Lower is better: 0 exact name … 4 format … 5 other. */
  readonly rank: number;
}

export interface SearchWorkspaceDto {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly rank: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

/**
 * Owner-scoped metadata search across active documents (and matching
 * workspace names). No Office content search.
 */
export function createSearchService(db: Db) {
  return {
    async search(input: {
      ownerUserId: string;
      query: string;
      limit?: number;
    }): Promise<{
      documents: SearchDocumentDto[];
      workspaces: SearchWorkspaceDto[];
    }> {
      const q = input.query.trim();
      const limit = Math.min(
        Math.max(input.limit ?? DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );

      if (!q) {
        return { documents: [], workspaces: [] };
      }

      const qLower = q.toLowerCase();
      const formatMatch = parseFormatQuery(qLower);
      const like = `%${escapeLike(qLower)}%`;
      const prefix = `${escapeLike(qLower)}%`;

      const docRank = sql<number>`
        case
          when lower(${schema.document.name}) = ${qLower} then 0
          when lower(${schema.document.name}) like ${prefix} escape '\\' then 1
          when lower(${schema.document.name}) like ${like} escape '\\' then 2
          when lower(${schema.workspace.name}) like ${like} escape '\\' then 3
          when ${
            formatMatch
              ? sql`${schema.document.format} = ${formatMatch}`
              : sql`false`
          } then 4
          else 5
        end
      `.as("rank");

      const docs = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceName: schema.workspace.name,
          name: schema.document.name,
          format: schema.document.format,
          updatedAt: schema.document.updatedAt,
          rank: docRank,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .where(
          and(
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
            formatMatch
              ? sql`(
                  lower(${schema.document.name}) like ${like} escape '\\'
                  or lower(${schema.workspace.name}) like ${like} escape '\\'
                  or ${schema.document.format} = ${formatMatch}
                )`
              : sql`(
                  lower(${schema.document.name}) like ${like} escape '\\'
                  or lower(${schema.workspace.name}) like ${like} escape '\\'
                )`,
          ),
        )
        .orderBy(asc(docRank), desc(schema.document.updatedAt))
        .limit(limit);

      const wsRank = sql<number>`
        case
          when lower(${schema.workspace.name}) = ${qLower} then 0
          when lower(${schema.workspace.name}) like ${prefix} escape '\\' then 1
          else 2
        end
      `.as("rank");

      const workspaces = await db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          updatedAt: schema.workspace.updatedAt,
          rank: wsRank,
        })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.workspace.deletedAt),
            sql`lower(${schema.workspace.name}) like ${like} escape '\\'`,
          ),
        )
        .orderBy(asc(wsRank), desc(schema.workspace.updatedAt))
        .limit(Math.min(10, limit));

      return {
        documents: docs.map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          name: row.name,
          format: row.format,
          updatedAt: row.updatedAt.toISOString(),
          rank: Number(row.rank),
        })),
        workspaces: workspaces.map((row) => ({
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt.toISOString(),
          rank: Number(row.rank),
        })),
      };
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseFormatQuery(qLower: string): OfficeFormat | null {
  if (qLower === "docx" || qLower === "word" || qLower === "write") {
    return "docx";
  }
  if (qLower === "pptx" || qLower === "powerpoint" || qLower === "slides") {
    return "pptx";
  }
  if (qLower === "xlsx" || qLower === "excel" || qLower === "sheets") {
    return "xlsx";
  }
  return null;
}
