import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import {
  DocumentAccessError,
  type DocumentService,
} from "../documents/service.js";
import type { WorkspaceService } from "../workspaces/service.js";
import { WorkspaceAccessError } from "../workspaces/service.js";

function unauthenticated() {
  return {
    error: {
      statusCode: 401 as const,
      message: "Unauthorized",
      code: "UNAUTHENTICATED" as const,
    },
  };
}

const DocumentIdParams = z.object({
  documentId: z.uuid("documentId must be a UUID"),
});
const WorkspaceIdParams = z.object({
  workspaceId: z.uuid("workspaceId must be a UUID"),
});
const PurgeSelectionBody = z.object({
  workspaceIds: z.array(z.uuid()).default([]),
  documentIds: z.array(z.uuid()).default([]),
});

async function purgeSelection(
  ownerUserId: string,
  workspaces: WorkspaceService,
  documents: DocumentService,
  selection: { workspaceIds: readonly string[]; documentIds: readonly string[] },
): Promise<void> {
  // Workspaces first — their purge removes nested documents.
  for (const workspaceId of selection.workspaceIds) {
    try {
      await workspaces.purge({ workspaceId, ownerUserId });
    } catch (error) {
      // Idempotent for bulk/empty: already-gone rows are success.
      if (
        error instanceof WorkspaceAccessError &&
        error.code === "WORKSPACE_NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
  }
  for (const documentId of selection.documentIds) {
    try {
      await documents.purge({ documentId, ownerUserId });
    } catch (error) {
      if (
        error instanceof DocumentAccessError &&
        error.code === "DOCUMENT_NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Trash lists owned soft-deleted workspaces and documents.
 */
export function registerTrashRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  workspaces: WorkspaceService,
  documents: DocumentService,
): void {
  app.get("/api/trash", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const [trashedWorkspaces, trashedDocuments] = await Promise.all([
      workspaces.listTrash(user.id),
      documents.listTrash(user.id),
    ]);

    return reply.send({
      workspaces: trashedWorkspaces,
      documents: trashedDocuments,
    });
  });

  app.delete("/api/trash/documents/:documentId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated());

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
      await documents.purge({
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

  app.delete("/api/trash/workspaces/:workspaceId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated());

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

    try {
      await workspaces.purge({
        workspaceId: params.data.workspaceId,
        ownerUserId: user.id,
      });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
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

  /** Permanently delete selected trashed workspaces and/or documents. */
  app.post("/api/trash/purge", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated());

    const body = PurgeSelectionBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: body.error.issues[0]?.message ?? "Invalid purge selection",
          code: "INVALID_PURGE_SELECTION",
        },
      });
    }
    if (
      body.data.workspaceIds.length === 0 &&
      body.data.documentIds.length === 0
    ) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "Select at least one workspace or document",
          code: "EMPTY_PURGE_SELECTION",
        },
      });
    }

    try {
      await purgeSelection(user.id, workspaces, documents, body.data);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DocumentAccessError || error instanceof WorkspaceAccessError) {
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

  /** Permanently delete everything currently in the owner's trash. */
  app.delete("/api/trash", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated());

    try {
      const [trashedWorkspaces, trashedDocuments] = await Promise.all([
        workspaces.listTrash(user.id),
        documents.listTrash(user.id),
      ]);
      await purgeSelection(user.id, workspaces, documents, {
        workspaceIds: trashedWorkspaces.map((row) => row.id),
        documentIds: trashedDocuments.map((row) => row.id),
      });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DocumentAccessError || error instanceof WorkspaceAccessError) {
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
