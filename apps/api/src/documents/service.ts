import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { and, desc, eq, isNull, max } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../storage/types.js";
import {
  contentDispositionForDocument,
  contentTypeForFormat,
  officeFormatFromFilename,
  sanitizeUploadFilename,
  type OfficeFormat,
} from "./format.js";
import { buildDocumentVersionStorageKey } from "./storage-key.js";

export interface DocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentVersionDto {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly source: "upload";
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface UploadedDocumentDto {
  readonly document: DocumentDto;
  readonly version: DocumentVersionDto;
}

export type DocumentVersionSource = "upload" | "user" | "agent" | "system";

export interface ListedDocumentVersionDto {
  readonly id: string;
  readonly versionNumber: number;
  readonly sizeBytes: number;
  readonly source: DocumentVersionSource;
  readonly createdAt: string;
}

export interface ListedDocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestVersion: ListedDocumentVersionDto;
}

export interface DocumentDownload {
  readonly body: Readable;
  readonly contentType: string;
  readonly contentLength: number;
  readonly contentDisposition: string;
}

export type DocumentUploadErrorCode =
  | "INVALID_FILENAME"
  | "UNSUPPORTED_FORMAT"
  | "EMPTY_UPLOAD"
  | "UPLOAD_TOO_LARGE";

export class DocumentUploadError extends Error {
  readonly statusCode: number;
  readonly code: DocumentUploadErrorCode;

  constructor(
    statusCode: number,
    code: DocumentUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentUploadError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type DocumentAccessErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "STORAGE_OBJECT_MISSING";

export class DocumentAccessError extends Error {
  readonly statusCode: number;
  readonly code: DocumentAccessErrorCode;

  constructor(
    statusCode: number,
    code: DocumentAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentAccessError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface DocumentServiceOptions {
  readonly uploadMaxBytes: number;
  /** Injectable for tests that need deterministic IDs / forced PK conflicts. */
  readonly createId?: () => string;
  /** Optional logger for best-effort cleanup failures after a DB write error. */
  readonly onCleanupFailure?: (error: unknown, storageKey: string) => void;
  /** Optional logger when DB points at a missing storage object. */
  readonly onMissingStorageObject?: (details: {
    documentId: string;
    versionId: string;
    storageKey: string;
    error: unknown;
  }) => void;
}

/**
 * Document upload, list, and latest-version download against owned workspaces.
 */
export function createDocumentService(
  db: Db,
  storage: ObjectStorage,
  options: DocumentServiceOptions,
) {
  const createId = options.createId ?? randomUUID;

  return {
    async uploadOfficeDocument(input: {
      workspaceId: string;
      ownerUserId: string;
      filename: string;
      bytes: Buffer;
    }): Promise<UploadedDocumentDto> {
      const filename = sanitizeUploadFilename(input.filename);
      if (!filename) {
        throw new DocumentUploadError(
          400,
          "INVALID_FILENAME",
          "Invalid upload filename",
        );
      }

      const format = officeFormatFromFilename(filename);
      if (!format) {
        throw new DocumentUploadError(
          400,
          "UNSUPPORTED_FORMAT",
          "Only .docx, .pptx, and .xlsx uploads are supported",
        );
      }

      if (input.bytes.byteLength === 0) {
        throw new DocumentUploadError(
          400,
          "EMPTY_UPLOAD",
          "Uploaded file is empty",
        );
      }

      if (input.bytes.byteLength > options.uploadMaxBytes) {
        throw new DocumentUploadError(
          413,
          "UPLOAD_TOO_LARGE",
          `Uploaded file exceeds the ${options.uploadMaxBytes} byte limit`,
        );
      }

      const documentId = createId();
      const versionId = createId();
      const storageKey = buildDocumentVersionStorageKey({
        workspaceId: input.workspaceId,
        documentId,
        versionId,
        format,
      });

      await storage.putObject({
        key: storageKey,
        body: input.bytes,
        contentType: contentTypeForFormat(format),
      });

      try {
        const created = await db.transaction(async (tx) => {
          const [doc] = await tx
            .insert(schema.document)
            .values({
              id: documentId,
              workspaceId: input.workspaceId,
              name: filename,
              format,
            })
            .returning({
              id: schema.document.id,
              workspaceId: schema.document.workspaceId,
              name: schema.document.name,
              format: schema.document.format,
              createdAt: schema.document.createdAt,
              updatedAt: schema.document.updatedAt,
            });

          if (!doc) {
            throw new Error("Failed to create document");
          }

          const [version] = await tx
            .insert(schema.documentVersion)
            .values({
              id: versionId,
              documentId,
              versionNumber: 1,
              parentVersionId: null,
              storageKey,
              sizeBytes: input.bytes.byteLength,
              sha256: null,
              source: "upload",
              createdByUserId: input.ownerUserId,
            })
            .returning({
              id: schema.documentVersion.id,
              documentId: schema.documentVersion.documentId,
              versionNumber: schema.documentVersion.versionNumber,
              storageKey: schema.documentVersion.storageKey,
              sizeBytes: schema.documentVersion.sizeBytes,
              source: schema.documentVersion.source,
              createdByUserId: schema.documentVersion.createdByUserId,
              createdAt: schema.documentVersion.createdAt,
            });

          if (
            !version ||
            version.source !== "upload" ||
            version.createdByUserId == null
          ) {
            throw new Error("Failed to create document version");
          }

          return {
            doc,
            version: {
              ...version,
              createdByUserId: version.createdByUserId,
            },
          };
        });

        return {
          document: {
            id: created.doc.id,
            workspaceId: created.doc.workspaceId,
            name: created.doc.name,
            format: created.doc.format,
            createdAt: created.doc.createdAt.toISOString(),
            updatedAt: created.doc.updatedAt.toISOString(),
          },
          version: {
            id: created.version.id,
            documentId: created.version.documentId,
            versionNumber: created.version.versionNumber,
            storageKey: created.version.storageKey,
            sizeBytes: created.version.sizeBytes,
            source: "upload",
            createdByUserId: created.version.createdByUserId,
            createdAt: created.version.createdAt.toISOString(),
          },
        };
      } catch (error) {
        try {
          await storage.deleteObject(storageKey);
        } catch (cleanupError) {
          options.onCleanupFailure?.(cleanupError, storageKey);
        }
        throw error;
      }
    },

    /**
     * Lists non-deleted documents in a workspace with each document's latest
     * version (max `version_number`). Caller must already enforce ownership.
     * Uses a grouped join so this is not an N+1.
     */
    async listInWorkspace(workspaceId: string): Promise<ListedDocumentDto[]> {
      const latestByDocument = db
        .select({
          documentId: schema.documentVersion.documentId,
          maxVersionNumber: max(schema.documentVersion.versionNumber).as(
            "max_version_number",
          ),
        })
        .from(schema.documentVersion)
        .groupBy(schema.documentVersion.documentId)
        .as("latest_by_document");

      const rows = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          versionId: schema.documentVersion.id,
          versionNumber: schema.documentVersion.versionNumber,
          sizeBytes: schema.documentVersion.sizeBytes,
          source: schema.documentVersion.source,
          versionCreatedAt: schema.documentVersion.createdAt,
        })
        .from(schema.document)
        .innerJoin(
          latestByDocument,
          eq(schema.document.id, latestByDocument.documentId),
        )
        .innerJoin(
          schema.documentVersion,
          and(
            eq(schema.documentVersion.documentId, schema.document.id),
            eq(
              schema.documentVersion.versionNumber,
              latestByDocument.maxVersionNumber,
            ),
          ),
        )
        .where(
          and(
            eq(schema.document.workspaceId, workspaceId),
            isNull(schema.document.deletedAt),
          ),
        )
        .orderBy(
          desc(schema.document.updatedAt),
          desc(schema.document.createdAt),
          desc(schema.document.id),
        );

      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        format: row.format,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        latestVersion: {
          id: row.versionId,
          versionNumber: row.versionNumber,
          sizeBytes: row.sizeBytes,
          source: row.source,
          createdAt: row.versionCreatedAt.toISOString(),
        },
      }));
    },

    /**
     * Returns one owned, non-deleted document with its latest version.
     * Soft-deleted document or workspace → not found.
     */
    async getOwnedDocument(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<ListedDocumentDto> {
      const [row] = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          name: schema.document.name,
          format: schema.document.format,
          createdAt: schema.document.createdAt,
          updatedAt: schema.document.updatedAt,
          versionId: schema.documentVersion.id,
          versionNumber: schema.documentVersion.versionNumber,
          sizeBytes: schema.documentVersion.sizeBytes,
          source: schema.documentVersion.source,
          versionCreatedAt: schema.documentVersion.createdAt,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .innerJoin(
          schema.documentVersion,
          eq(schema.documentVersion.documentId, schema.document.id),
        )
        .where(
          and(
            eq(schema.document.id, input.documentId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(desc(schema.documentVersion.versionNumber))
        .limit(1);

      if (!row) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      return {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        format: row.format,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        latestVersion: {
          id: row.versionId,
          versionNumber: row.versionNumber,
          sizeBytes: row.sizeBytes,
          source: row.source,
          createdAt: row.versionCreatedAt.toISOString(),
        },
      };
    },

    /**
     * Opens a streaming download of the latest version for a document owned by
     * `ownerUserId` (via its workspace). Soft-deleted document/workspace → not found.
     */
    async openLatestDownload(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<DocumentDownload> {
      const [row] = await db
        .select({
          documentId: schema.document.id,
          name: schema.document.name,
          format: schema.document.format,
          versionId: schema.documentVersion.id,
          versionNumber: schema.documentVersion.versionNumber,
          sizeBytes: schema.documentVersion.sizeBytes,
          storageKey: schema.documentVersion.storageKey,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .innerJoin(
          schema.documentVersion,
          eq(schema.documentVersion.documentId, schema.document.id),
        )
        .where(
          and(
            eq(schema.document.id, input.documentId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.document.deletedAt),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .orderBy(desc(schema.documentVersion.versionNumber))
        .limit(1);

      if (!row) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      try {
        const object = await storage.getObject(row.storageKey);
        const contentLength = object.contentLength ?? row.sizeBytes;

        return {
          body: object.body,
          contentType: contentTypeForFormat(row.format),
          contentLength,
          contentDisposition: contentDispositionForDocument(
            row.name,
            row.format,
          ),
        };
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          options.onMissingStorageObject?.({
            documentId: row.documentId,
            versionId: row.versionId,
            storageKey: row.storageKey,
            error,
          });
          throw new DocumentAccessError(
            500,
            "STORAGE_OBJECT_MISSING",
            "Document content is temporarily unavailable",
          );
        }
        throw error;
      }
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
