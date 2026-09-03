import { randomUUID } from "node:crypto";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type { ObjectStorage } from "../storage/types.js";
import {
  contentTypeForFormat,
  officeFormatFromFilename,
  sanitizeUploadFilename,
} from "./format.js";
import { buildDocumentVersionStorageKey } from "./storage-key.js";

export interface DocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly format: "docx" | "pptx" | "xlsx";
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

export interface DocumentServiceOptions {
  readonly uploadMaxBytes: number;
  /** Injectable for tests that need deterministic IDs / forced PK conflicts. */
  readonly createId?: () => string;
  /** Optional logger for best-effort cleanup failures after a DB error. */
  readonly onCleanupFailure?: (error: unknown, storageKey: string) => void;
}

/**
 * First Office document upload: put bytes in object storage, then insert
 * `document` + version 1 in one Postgres transaction. If the DB write fails,
 * best-effort delete the uploaded object.
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
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
