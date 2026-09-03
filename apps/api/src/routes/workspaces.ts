import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { WorkspaceService } from "../workspaces/service.js";

const CreateWorkspaceBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be at most 100 characters"),
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
 * Authenticated workspace list + create. Ownership is enforced by always
 * scoping queries to `getRequestUser(...).id` — never accepting an owner
 * from the client body.
 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  workspaces: WorkspaceService,
): void {
  app.get("/api/workspaces", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const list = await workspaces.listOwned(user.id);
    return reply.send({ workspaces: list });
  });

  app.post("/api/workspaces", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const parsed = CreateWorkspaceBody.safeParse(request.body);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Invalid workspace name";
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message,
          code: "INVALID_WORKSPACE_NAME",
        },
      });
    }

    const workspace = await workspaces.create({
      ownerUserId: user.id,
      name: parsed.data.name,
    });

    return reply.status(201).send({ workspace });
  });
}
