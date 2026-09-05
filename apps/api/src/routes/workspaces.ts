import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { WorkspaceService } from "../workspaces/service.js";

const WorkspaceNameBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be at most 100 characters"),
});

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

function workspaceNotFound() {
  return {
    error: {
      statusCode: 404 as const,
      message: "Workspace not found",
      code: "WORKSPACE_NOT_FOUND" as const,
    },
  };
}

/**
 * Authenticated workspace list/create/rename/delete. Ownership is enforced by
 * always scoping to `getRequestUser(...).id` — never accepting an owner from
 * the client body.
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

    const list = await workspaces.listOwnedSummaries(user.id);
    return reply.send({ workspaces: list });
  });

  app.post("/api/workspaces", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const parsed = WorkspaceNameBody.safeParse(request.body);
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

    return reply.status(201).send({
      workspace: {
        ...workspace,
        documentCount: 0,
        recentDocuments: [],
      },
    });
  });

  app.patch("/api/workspaces/:workspaceId", async (request, reply) => {
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

    const parsed = WorkspaceNameBody.safeParse(request.body);
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

    const workspace = await workspaces.rename({
      workspaceId: params.data.workspaceId,
      ownerUserId: user.id,
      name: parsed.data.name,
    });
    if (!workspace) {
      return reply.status(404).send(workspaceNotFound());
    }

    return reply.send({ workspace });
  });

  app.delete("/api/workspaces/:workspaceId", async (request, reply) => {
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

    const deleted = await workspaces.softDelete({
      workspaceId: params.data.workspaceId,
      ownerUserId: user.id,
    });
    if (!deleted) {
      return reply.status(404).send(workspaceNotFound());
    }

    return reply.status(204).send();
  });
}
