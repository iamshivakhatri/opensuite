import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import {
  DocumentAccessError,
  DocumentUploadError,
  type DocumentService,
} from "../documents/service.js";
import type { DocumentPreferenceService } from "../documents/preferences.js";
import type { WorkspaceService } from "../workspaces/service.js";

const WorkspaceIdParams = z.object({
  workspaceId: z.uuid("workspaceId must be a UUID"),
});

const DocumentIdParams = z.object({
  documentId: z.uuid("documentId must be a UUID"),
});

const DocumentVersionParams = z.object({
  documentId: z.uuid("documentId must be a UUID"),
  versionId: z.uuid("versionId must be a UUID"),
});

const SetStarBody = z.object({
  starred: z.boolean(),
});

const RenameDocumentBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Document name is required")
    .max(255, "Document name must be at most 255 characters"),
});

const LibraryFormatQuery = z.object({
  format: z.enum(["docx", "pptx", "xlsx"]),
});

function unauthenticated() {
  return {
    error: {
      statusCode: 401 as const,
      message: "Unauthorized",
      code: "UNAUTHENTICATED" as const,
    },
  };
}

const CreateBlankDocumentBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional(),
});

/**
 * Authenticated Office document upload, list, download, and per-user prefs
 * (recent / starred / format library).
 */
export function registerDocumentRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  workspaces: WorkspaceService,
  documents: DocumentService,
  preferences: DocumentPreferenceService,
): void {
  // Static library routes before parametric /:documentId.
  app.get("/api/documents/recent", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }
    const list = await preferences.listRecent(user.id);
    return reply.send({ documents: list });
  });

  app.get("/api/documents/starred", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }
    const list = await preferences.listStarred(user.id);
    return reply.send({ documents: list });
  });

  app.get("/api/documents/library", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const query = LibraryFormatQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "format must be docx, pptx, or xlsx",
          code: "INVALID_FORMAT",
        },
      });
    }

    const list = await preferences.listByFormat({
      ownerUserId: user.id,
      format: query.data.format,
    });
    return reply.send({ documents: list });
  });

  app.get(
    "/api/workspaces/:workspaceId/documents",
    async (request, reply) => {
      const user = await getRequestUser(auth, request);
      if (!user) {
        return reply.status(401).send(unauthenticated());
      }

      const params = WorkspaceIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: params.error.issues[0]?.message ?? "Invalid workspace id",
            code: "INVALID_WORKSPACE_ID",
          },
        });
      }

      const workspace = await workspaces.getOwned(
        params.data.workspaceId,
        user.id,
      );
      if (!workspace) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Workspace not found",
            code: "WORKSPACE_NOT_FOUND",
          },
        });
      }

      const list = await documents.listInWorkspace(workspace.id, user.id);
      return reply.send({ documents: list });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/documents/blank",
    async (request, reply) => {
      const user = await getRequestUser(auth, request);
      if (!user) {
        return reply.status(401).send(unauthenticated());
      }

      const params = WorkspaceIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: params.error.issues[0]?.message ?? "Invalid workspace id",
            code: "INVALID_WORKSPACE_ID",
          },
        });
      }

      const body = CreateBlankDocumentBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: body.error.issues[0]?.message ?? "Invalid request body",
            code: "INVALID_BODY",
          },
        });
      }

      const workspace = await workspaces.getOwned(
        params.data.workspaceId,
        user.id,
      );
      if (!workspace) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Workspace not found",
            code: "WORKSPACE_NOT_FOUND",
          },
        });
      }

      try {
        const created = await documents.createBlankDocxDocument({
          workspaceId: workspace.id,
          ownerUserId: user.id,
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        });
        return reply.status(201).send(created);
      } catch (error) {
        if (error instanceof DocumentUploadError) {
          return reply.status(error.statusCode).send({
            error: {
              statusCode: error.statusCode,
              message: error.message,
              code: error.code,
            },
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/documents",
    async (request, reply) => {
      const user = await getRequestUser(auth, request);
      if (!user) {
        return reply.status(401).send(unauthenticated());
      }

      const params = WorkspaceIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: params.error.issues[0]?.message ?? "Invalid workspace id",
            code: "INVALID_WORKSPACE_ID",
          },
        });
      }

      const workspace = await workspaces.getOwned(
        params.data.workspaceId,
        user.id,
      );
      if (!workspace) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Workspace not found",
            code: "WORKSPACE_NOT_FOUND",
          },
        });
      }

      let file;
      try {
        file = await request.file();
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : undefined;

        if (statusCode === 413) {
          return reply.status(413).send({
            error: {
              statusCode: 413,
              message: "Uploaded file is too large",
              code: "UPLOAD_TOO_LARGE",
            },
          });
        }
        throw error;
      }

      if (!file) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: "A file upload is required",
            code: "MISSING_FILE",
          },
        });
      }

      const bytes = await file.toBuffer();

      try {
        const uploaded = await documents.uploadOfficeDocument({
          workspaceId: workspace.id,
          ownerUserId: user.id,
          filename: file.filename,
          bytes,
        });
        return reply.status(201).send(uploaded);
      } catch (error) {
        if (error instanceof DocumentUploadError) {
          return reply.status(error.statusCode).send({
            error: {
              statusCode: error.statusCode,
              message: error.message,
              code: error.code,
            },
          });
        }
        throw error;
      }
    },
  );

  app.get("/api/documents/:documentId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    try {
      const document = await documents.getOwnedDocument({
        documentId: params.data.documentId,
        ownerUserId: user.id,
      });
      // Best-effort open tracking for Recent — do not fail the GET.
      try {
        await preferences.recordOpened({
          documentId: document.id,
          ownerUserId: user.id,
        });
      } catch {
        // ignore preference write failures
      }
      const star = await preferences.getStarState({
        documentId: document.id,
        ownerUserId: user.id,
      });
      return reply.send({ document: { ...document, starred: star.starred } });
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  app.put("/api/documents/:documentId/star", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    const body = SetStarBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "starred must be a boolean",
          code: "INVALID_STAR_BODY",
        },
      });
    }

    try {
      const result = await preferences.setStarred({
        documentId: params.data.documentId,
        ownerUserId: user.id,
        starred: body.data.starred,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  app.patch("/api/documents/:documentId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    const body = RenameDocumentBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: body.error.issues[0]?.message ?? "Invalid document name",
          code: "INVALID_DOCUMENT_NAME",
        },
      });
    }

    try {
      const document = await documents.rename({
        documentId: params.data.documentId,
        ownerUserId: user.id,
        name: body.data.name,
      });
      return reply.send({ document });
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  app.delete("/api/documents/:documentId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    try {
      await documents.softDelete({
        documentId: params.data.documentId,
        ownerUserId: user.id,
      });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  app.post("/api/documents/:documentId/restore", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    try {
      const document = await documents.restore({
        documentId: params.data.documentId,
        ownerUserId: user.id,
      });
      return reply.send({ document });
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  app.get("/api/documents/:documentId/download", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    try {
      const download = await documents.openLatestDownload({
        documentId: params.data.documentId,
        ownerUserId: user.id,
      });

      return reply
        .header("Content-Type", download.contentType)
        .header("Content-Disposition", download.contentDisposition)
        .header("Content-Length", String(download.contentLength))
        .send(download.body);
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });

  /**
   * Exact immutable version bytes (not latest). Owner-only; active
   * document/workspace required. Version must belong to the document.
   */
  app.get(
    "/api/documents/:documentId/versions/:versionId/content",
    async (request, reply) => {
      const user = await getRequestUser(auth, request);
      if (!user) {
        return reply.status(401).send(unauthenticated());
      }

      const params = DocumentVersionParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: params.error.issues[0]?.message ?? "Invalid version id",
            code: "INVALID_VERSION_ID",
          },
        });
      }

      try {
        const download = await documents.openVersionContent({
          documentId: params.data.documentId,
          versionId: params.data.versionId,
          ownerUserId: user.id,
        });

        return reply
          .header("Content-Type", download.contentType)
          .header("Content-Disposition", download.contentDisposition)
          .header("Content-Length", String(download.contentLength))
          .send(download.body);
      } catch (error) {
        if (error instanceof DocumentAccessError) {
          return reply.status(error.statusCode).send({
            error: {
              statusCode: error.statusCode,
              message: error.message,
              code: error.code,
            },
          });
        }
        throw error;
      }
    },
  );

  /**
   * Human save: append exported Office bytes as a new immutable user version.
   * Client supplies baseVersionId + file only — never storage keys or version numbers.
   */
  app.post("/api/documents/:documentId/versions", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = DocumentIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid document id",
          code: "INVALID_DOCUMENT_ID",
        },
      });
    }

    let baseVersionId: string | undefined;
    let bytes: Buffer | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          bytes = await part.toBuffer();
        } else if (
          part.type === "field" &&
          part.fieldname === "baseVersionId"
        ) {
          baseVersionId =
            typeof part.value === "string" ? part.value.trim() : undefined;
        }
      }
    } catch (error) {
      const statusCode =
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof (error as { statusCode: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : undefined;

      if (statusCode === 413) {
        return reply.status(413).send({
          error: {
            statusCode: 413,
            message: "Uploaded file is too large",
            code: "UPLOAD_TOO_LARGE",
          },
        });
      }
      throw error;
    }

    if (!bytes) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "A file upload is required",
          code: "MISSING_FILE",
        },
      });
    }

    const baseParsed = z
      .uuid("baseVersionId must be a UUID")
      .safeParse(baseVersionId);
    if (!baseParsed.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "baseVersionId is required and must be a UUID",
          code: "MISSING_BASE_VERSION",
        },
      });
    }

    try {
      const saved = await documents.appendDocumentVersion({
        documentId: params.data.documentId,
        ownerUserId: user.id,
        baseVersionId: baseParsed.data,
        source: "user",
        bytes,
      });
      return reply.status(201).send(saved);
    } catch (error) {
      if (error instanceof DocumentUploadError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      if (error instanceof DocumentAccessError) {
        return reply.status(error.statusCode).send({
          error: {
            statusCode: error.statusCode,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });
}
