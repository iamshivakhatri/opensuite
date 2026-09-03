import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import {
  DocumentUploadError,
  type DocumentService,
} from "../documents/service.js";
import type { WorkspaceService } from "../workspaces/service.js";

const WorkspaceIdParams = z.object({
  workspaceId: z.uuid("workspaceId must be a UUID"),
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

/**
 * Authenticated Office document upload into a workspace the caller owns.
 */
export function registerDocumentRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  workspaces: WorkspaceService,
  documents: DocumentService,
): void {
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
}
