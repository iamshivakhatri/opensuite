import type { FastifyInstance } from "fastify";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { DocumentService } from "../documents/service.js";
import type { WorkspaceService } from "../workspaces/service.js";

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
}
