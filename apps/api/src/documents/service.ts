import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { and, desc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../storage/types.js";
import {
  contentDispositionForDocument,
  contentTypeForFormat,
  normalizeDocumentRenameName,
  officeFormatFromFilename,
  sanitizeUploadFilename,
  type OfficeFormat,
} from "./format.js";
import { buildDocumentVersionStorageKey } from "./storage-key.js";
import { StorageQuotaError, type StorageAccountingService } from "../storage-accounting/service.js";

export interface DocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DocumentVersionSource = "upload" | "user" | "agent" | "system";

/** Append sources only — upload creates document + v1, not appends. */
export type AppendDocumentVersionSource = Exclude<
  DocumentVersionSource,
  "upload"
>;

/**
 * Public version DTO. Never includes storageKey or storage URLs.
 */
export interface DocumentVersionDto {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly parentVersionId: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly source: DocumentVersionSource;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface UploadedDocumentDto {
  readonly document: DocumentDto;
  readonly version: DocumentVersionDto;
}

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

export interface AppendedDocumentDto {
  readonly document: ListedDocumentDto;
  readonly version: DocumentVersionDto;
}

export interface TrashedDocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceDeleted: boolean;
  readonly name: string;
  readonly format: OfficeFormat;
  readonly deletedAt: string;
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
  | "UPLOAD_TOO_LARGE"
  | "MISSING_BASE_VERSION"
  | "BLANK_DOCX_UNAVAILABLE"
  | "STORAGE_QUOTA_EXCEEDED";

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
  | "STORAGE_OBJECT_MISSING"
  | "INVALID_DOCUMENT_NAME"
  | "WORKSPACE_DELETED"
  | "VERSION_CONFLICT";

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
  /**
   * Rust blank DOCX bytes (via engine-client binding).
   * Required for createBlankDocxDocument — never invent DOCX in TypeScript.
   */
  readonly createBlankDocxBytes?: () => Uint8Array | Promise<Uint8Array>;
  /** Optional logger for best-effort cleanup failures after a DB write error. */
  readonly onCleanupFailure?: (error: unknown, storageKey: string) => void;
  /** Optional logger when DB points at a missing storage object. */
  readonly onMissingStorageObject?: (details: {
    documentId: string;
    versionId: string;
    storageKey: string;
    error: unknown;
  }) => void;
  readonly storageAccounting?: StorageAccountingService;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  if (code === "23505") {
    return true;
  }

  const cause =
    "cause" in error && error.cause && typeof error.cause === "object"
      ? error.cause
      : null;
  return cause !== null && "code" in cause && cause.code === "23505";
}

function toListedDocument(row: {
  id: string;
  workspaceId: string;
  name: string;
  format: OfficeFormat;
  createdAt: Date;
  updatedAt: Date;
  versionId: string;
  versionNumber: number;
  sizeBytes: number;
  source: DocumentVersionSource;
  versionCreatedAt: Date;
}): ListedDocumentDto {
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
}

function toVersionDto(row: {
  id: string;
  documentId: string;
  versionNumber: number;
  parentVersionId: string | null;
  sizeBytes: number;
  sha256: string | null;
  source: DocumentVersionSource;
  createdByUserId: string;
  createdAt: Date;
}): DocumentVersionDto {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    parentVersionId: row.parentVersionId,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    source: row.source,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Document upload, immutable version append, list, and versioned download
 * against owned workspaces.
 */
export function createDocumentService(
  db: Db,
  storage: ObjectStorage,
  options: DocumentServiceOptions,
) {
  const createId = options.createId ?? randomUUID;

  async function cleanupStorageKey(storageKey: string): Promise<void> {
    try {
      await storage.deleteObject(storageKey);
    } catch (cleanupError) {
      options.onCleanupFailure?.(cleanupError, storageKey);
    }
  }

  function assertUploadBytes(bytes: Buffer): void {
    if (bytes.byteLength === 0) {
      throw new DocumentUploadError(
        400,
        "EMPTY_UPLOAD",
        "Uploaded file is empty",
      );
    }

    if (bytes.byteLength > options.uploadMaxBytes) {
      throw new DocumentUploadError(
        413,
        "UPLOAD_TOO_LARGE",
        `Uploaded file exceeds the ${options.uploadMaxBytes} byte limit`,
      );
    }
  }

  async function openStoredVersion(input: {
    documentId: string;
    versionId: string;
    name: string;
    format: OfficeFormat;
    sizeBytes: number;
    storageKey: string;
  }): Promise<DocumentDownload> {
    try {
      const object = await storage.getObject(input.storageKey);
      const contentLength = object.contentLength ?? input.sizeBytes;

      return {
        body: object.body,
        contentType: contentTypeForFormat(input.format),
        contentLength,
        contentDisposition: contentDispositionForDocument(
          input.name,
          input.format,
        ),
      };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        options.onMissingStorageObject?.({
          documentId: input.documentId,
          versionId: input.versionId,
          storageKey: input.storageKey,
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
  }

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

      assertUploadBytes(input.bytes);

      const documentId = createId();
      const versionId = createId();
      const storageKey = buildDocumentVersionStorageKey({
        workspaceId: input.workspaceId,
        documentId,
        versionId,
        format,
      });
      const sha256 = sha256Hex(input.bytes);

      await storage.putObject({
        key: storageKey,
        body: input.bytes,
        contentType: contentTypeForFormat(format),
      });

      try {
        const created = await db.transaction(async (tx) => {
          await options.storageAccounting?.reserve(tx, input.ownerUserId, input.bytes.byteLength);
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
              sha256,
              source: "upload",
              createdByUserId: input.ownerUserId,
            })
            .returning({
              id: schema.documentVersion.id,
              documentId: schema.documentVersion.documentId,
              versionNumber: schema.documentVersion.versionNumber,
              parentVersionId: schema.documentVersion.parentVersionId,
              sizeBytes: schema.documentVersion.sizeBytes,
              sha256: schema.documentVersion.sha256,
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

          await tx
            .update(schema.workspace)
            .set({ updatedAt: new Date() })
            .where(eq(schema.workspace.id, input.workspaceId));

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
          version: toVersionDto(created.version),
        };
      } catch (error) {
        await cleanupStorageKey(storageKey);
        if (error instanceof StorageQuotaError) throw new DocumentUploadError(409, "STORAGE_QUOTA_EXCEEDED", error.message);
        throw error;
      }
    },

    /**
     * Create a new blank DOCX from Rust (engine-client), persist as Version 1.
     * Not a DocumentRuntime mutation — no DocumentRef exists yet.
     */
    async createBlankDocxDocument(input: {
      workspaceId: string;
      ownerUserId: string;
      /** Display name without requiring .docx; default Untitled Document.docx */
      name?: string;
    }): Promise<UploadedDocumentDto> {
      if (!options.createBlankDocxBytes) {
        throw new DocumentUploadError(
          500,
          "BLANK_DOCX_UNAVAILABLE",
          "Blank DOCX creation is not configured",
        );
      }

      const rawName = (input.name ?? "Untitled Document").trim() || "Untitled Document";
      const filename = sanitizeUploadFilename(
        rawName.toLowerCase().endsWith(".docx") ? rawName : `${rawName}.docx`,
      );
      if (!filename) {
        throw new DocumentUploadError(
          400,
          "INVALID_FILENAME",
          "Invalid document name",
        );
      }

      const blankBytes = await options.createBlankDocxBytes();
      const bytes = Buffer.from(blankBytes);
      assertUploadBytes(bytes);

      const documentId = createId();
      const versionId = createId();
      const storageKey = buildDocumentVersionStorageKey({
        workspaceId: input.workspaceId,
        documentId,
        versionId,
        format: "docx",
      });
      const sha256 = sha256Hex(bytes);

      await storage.putObject({
        key: storageKey,
        body: bytes,
        contentType: contentTypeForFormat("docx"),
      });

      try {
        const created = await db.transaction(async (tx) => {
          await options.storageAccounting?.reserve(tx, input.ownerUserId, bytes.byteLength);
          const [doc] = await tx
            .insert(schema.document)
            .values({
              id: documentId,
              workspaceId: input.workspaceId,
              name: filename,
              format: "docx",
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
              sizeBytes: bytes.byteLength,
              sha256,
              source: "user",
              createdByUserId: input.ownerUserId,
            })
            .returning({
              id: schema.documentVersion.id,
              documentId: schema.documentVersion.documentId,
              versionNumber: schema.documentVersion.versionNumber,
              parentVersionId: schema.documentVersion.parentVersionId,
              sizeBytes: schema.documentVersion.sizeBytes,
              sha256: schema.documentVersion.sha256,
              source: schema.documentVersion.source,
              createdByUserId: schema.documentVersion.createdByUserId,
              createdAt: schema.documentVersion.createdAt,
            });

          if (
            !version ||
            version.source !== "user" ||
            version.createdByUserId == null
          ) {
            throw new Error("Failed to create document version");
          }

          await tx
            .update(schema.workspace)
            .set({ updatedAt: new Date() })
            .where(eq(schema.workspace.id, input.workspaceId));

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
          version: toVersionDto(created.version),
        };
      } catch (error) {
        await cleanupStorageKey(storageKey);
        if (error instanceof StorageQuotaError) throw new DocumentUploadError(409, "STORAGE_QUOTA_EXCEEDED", error.message);
        throw error;
      }
    },

    /**
     * Append an immutable Office artifact as the next version of an existing
     * document. Requires `baseVersionId` to equal the current latest version
     * (optimistic concurrency). Reusable for human saves and future agent
     * artifacts. Never mutates existing version rows.
     */
    async appendDocumentVersion(input: {
      documentId: string;
      ownerUserId: string;
      baseVersionId: string;
      source: AppendDocumentVersionSource;
      bytes: Buffer;
    }): Promise<AppendedDocumentDto> {
      if (!input.baseVersionId) {
        throw new DocumentUploadError(
          400,
          "MISSING_BASE_VERSION",
          "baseVersionId is required",
        );
      }

      assertUploadBytes(input.bytes);

      const [owned] = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          name: schema.document.name,
          format: schema.document.format,
        })
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

      if (!owned) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      const versionId = createId();
      const storageKey = buildDocumentVersionStorageKey({
        workspaceId: owned.workspaceId,
        documentId: owned.id,
        versionId,
        format: owned.format,
      });
      const sha256 = sha256Hex(input.bytes);

      await storage.putObject({
        key: storageKey,
        body: input.bytes,
        contentType: contentTypeForFormat(owned.format),
      });

      try {
        const created = await db.transaction(async (tx) => {
          // Serialize version allocation per document. Unique(document_id,
          // version_number) is the second line of defense against races.
          await tx.execute(
            sql`select ${schema.document.id} from ${schema.document}
                where ${schema.document.id} = ${owned.id}
                for update`,
          );

          const [latest] = await tx
            .select({
              id: schema.documentVersion.id,
              versionNumber: schema.documentVersion.versionNumber,
            })
            .from(schema.documentVersion)
            .where(eq(schema.documentVersion.documentId, owned.id))
            .orderBy(desc(schema.documentVersion.versionNumber))
            .limit(1);

          if (!latest) {
            throw new DocumentAccessError(
              404,
              "DOCUMENT_NOT_FOUND",
              "Document not found",
            );
          }

          if (latest.id !== input.baseVersionId) {
            throw new DocumentAccessError(
              409,
              "VERSION_CONFLICT",
              "Document was updated; reload the latest version before saving",
            );
          }

          await options.storageAccounting?.reserve(tx, input.ownerUserId, input.bytes.byteLength);

          const nextVersionNumber = latest.versionNumber + 1;
          const now = new Date();

          const [version] = await tx
            .insert(schema.documentVersion)
            .values({
              id: versionId,
              documentId: owned.id,
              versionNumber: nextVersionNumber,
              parentVersionId: input.baseVersionId,
              storageKey,
              sizeBytes: input.bytes.byteLength,
              sha256,
              source: input.source,
              createdByUserId: input.ownerUserId,
            })
            .returning({
              id: schema.documentVersion.id,
              documentId: schema.documentVersion.documentId,
              versionNumber: schema.documentVersion.versionNumber,
              parentVersionId: schema.documentVersion.parentVersionId,
              sizeBytes: schema.documentVersion.sizeBytes,
              sha256: schema.documentVersion.sha256,
              source: schema.documentVersion.source,
              createdByUserId: schema.documentVersion.createdByUserId,
              createdAt: schema.documentVersion.createdAt,
            });

          if (!version || version.createdByUserId == null) {
            throw new Error("Failed to create document version");
          }

          const [doc] = await tx
            .update(schema.document)
            .set({ updatedAt: now })
            .where(eq(schema.document.id, owned.id))
            .returning({
              id: schema.document.id,
              workspaceId: schema.document.workspaceId,
              name: schema.document.name,
              format: schema.document.format,
              createdAt: schema.document.createdAt,
              updatedAt: schema.document.updatedAt,
            });

          if (!doc) {
            throw new Error("Failed to update document activity");
          }

          await tx
            .update(schema.workspace)
            .set({ updatedAt: now })
            .where(eq(schema.workspace.id, owned.workspaceId));

          return {
            document: toListedDocument({
              id: doc.id,
              workspaceId: doc.workspaceId,
              name: doc.name,
              format: doc.format,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
              versionId: version.id,
              versionNumber: version.versionNumber,
              sizeBytes: version.sizeBytes,
              source: version.source,
              versionCreatedAt: version.createdAt,
            }),
            version: toVersionDto({
              ...version,
              createdByUserId: version.createdByUserId,
            }),
          };
        });

        return created;
      } catch (error) {
        await cleanupStorageKey(storageKey);

        if (error instanceof StorageQuotaError) throw new DocumentUploadError(409, "STORAGE_QUOTA_EXCEEDED", error.message);

        if (
          error instanceof DocumentAccessError &&
          error.code === "VERSION_CONFLICT"
        ) {
          throw error;
        }

        if (isUniqueViolation(error)) {
          throw new DocumentAccessError(
            409,
            "VERSION_CONFLICT",
            "Document was updated; reload the latest version before saving",
          );
        }

        throw error;
      }
    },

    /**
     * Lists non-deleted documents in a workspace with each document's latest
     * version (max `version_number`). Caller must already enforce ownership.
     * Uses a grouped join so this is not an N+1.
     */
    async listInWorkspace(
      workspaceId: string,
      ownerUserId: string,
    ): Promise<Array<ListedDocumentDto & { starred: boolean }>> {
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
          starred: schema.documentUserState.starred,
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
        .leftJoin(
          schema.documentUserState,
          and(
            eq(schema.documentUserState.documentId, schema.document.id),
            eq(schema.documentUserState.userId, ownerUserId),
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
        ...toListedDocument(row),
        starred: row.starred ?? false,
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

      return toListedDocument(row);
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

      return openStoredVersion({
        documentId: row.documentId,
        versionId: row.versionId,
        name: row.name,
        format: row.format,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
      });
    },

    /**
     * Streams the exact immutable Office artifact for a specific version.
     * Version must belong to the owned, active document. Cross-document /
     * non-owned / deleted → not found (404).
     */
    async openVersionContent(input: {
      documentId: string;
      versionId: string;
      ownerUserId: string;
    }): Promise<DocumentDownload> {
      const [row] = await db
        .select({
          documentId: schema.document.id,
          name: schema.document.name,
          format: schema.document.format,
          versionId: schema.documentVersion.id,
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
          and(
            eq(schema.documentVersion.documentId, schema.document.id),
            eq(schema.documentVersion.id, input.versionId),
          ),
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

      return openStoredVersion({
        documentId: row.documentId,
        versionId: row.versionId,
        name: row.name,
        format: row.format,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
      });
    },

    /**
     * Loads exact immutable version bytes into memory (no Base64, no temp files).
     * Always the requested version — never silently substitutes latest.
     */
    async readExactVersionBytes(input: {
      documentId: string;
      versionId: string;
      ownerUserId: string;
    }): Promise<Buffer> {
      const download = await this.openVersionContent(input);
      const chunks: Buffer[] = [];
      for await (const chunk of download.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },

    /**
     * Renames an owned, non-deleted document. Preserves format; does not touch
     * storage keys or version artifacts.
     */
    async rename(input: {
      documentId: string;
      ownerUserId: string;
      name: string;
    }): Promise<ListedDocumentDto> {
      const existing = await this.getOwnedDocument({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
      });

      const nextName = normalizeDocumentRenameName(input.name, existing.format);
      if (!nextName) {
        throw new DocumentAccessError(
          400,
          "INVALID_DOCUMENT_NAME",
          "Invalid document name for this format",
        );
      }

      const [row] = await db
        .update(schema.document)
        .set({
          name: nextName,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.document.id, input.documentId),
            isNull(schema.document.deletedAt),
          ),
        )
        .returning({ id: schema.document.id });

      if (!row) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      await db
        .update(schema.workspace)
        .set({ updatedAt: new Date() })
        .where(eq(schema.workspace.id, existing.workspaceId));

      return this.getOwnedDocument({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
      });
    },

    /**
     * Soft-deletes an owned document. Versions and storage objects are kept.
     */
    async softDelete(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<boolean> {
      // Ownership + active workspace/document via getOwnedDocument.
      const existing = await this.getOwnedDocument({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
      });

      const [row] = await db
        .update(schema.document)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.document.id, existing.id),
            isNull(schema.document.deletedAt),
          ),
        )
        .returning({ id: schema.document.id });

      if (row) {
        await db
          .update(schema.workspace)
          .set({ updatedAt: new Date() })
          .where(eq(schema.workspace.id, existing.workspaceId));
      }

      return Boolean(row);
    },

    /**
     * Restores a soft-deleted document. Parent workspace must be active.
     */
    async restore(input: {
      documentId: string;
      ownerUserId: string;
    }): Promise<ListedDocumentDto> {
      const [row] = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceDeletedAt: schema.workspace.deletedAt,
          documentDeletedAt: schema.document.deletedAt,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .where(
          and(
            eq(schema.document.id, input.documentId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
          ),
        )
        .limit(1);

      if (!row || row.documentDeletedAt == null) {
        throw new DocumentAccessError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found",
        );
      }

      if (row.workspaceDeletedAt != null) {
        throw new DocumentAccessError(
          409,
          "WORKSPACE_DELETED",
          "Restore the workspace before restoring this document",
        );
      }

      await db
        .update(schema.document)
        .set({
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.document.id, input.documentId));

      await db
        .update(schema.workspace)
        .set({ updatedAt: new Date() })
        .where(eq(schema.workspace.id, row.workspaceId));

      return this.getOwnedDocument({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
      });
    },

    /**
     * Soft-deleted documents owned by the user (for Trash), including those
     * whose parent workspace is also trashed.
     */
    async listTrash(ownerUserId: string): Promise<TrashedDocumentDto[]> {
      const rows = await db
        .select({
          id: schema.document.id,
          workspaceId: schema.document.workspaceId,
          workspaceName: schema.workspace.name,
          workspaceDeletedAt: schema.workspace.deletedAt,
          name: schema.document.name,
          format: schema.document.format,
          deletedAt: schema.document.deletedAt,
        })
        .from(schema.document)
        .innerJoin(
          schema.workspace,
          eq(schema.document.workspaceId, schema.workspace.id),
        )
        .where(
          and(
            eq(schema.workspace.ownerUserId, ownerUserId),
            isNotNull(schema.document.deletedAt),
          ),
        )
        .orderBy(desc(schema.document.deletedAt));

      return rows
        .filter((row) => row.deletedAt != null)
        .map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          workspaceDeleted: row.workspaceDeletedAt != null,
          name: row.name,
          format: row.format,
          deletedAt: row.deletedAt!.toISOString(),
        }));
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
