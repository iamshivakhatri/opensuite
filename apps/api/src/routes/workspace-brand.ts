import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import { WorkspaceAccessError } from "../workspaces/service.js";
import { StorageQuotaError } from "../storage-accounting/service.js";
import {
  WorkspaceAssetError,
  type WorkspaceAssetService,
} from "../workspace-brand/assets.js";
import type { WorkspaceBrandService } from "../workspace-brand/service.js";
import {
  assetMaxBytes,
  workspaceBrandSchema,
} from "../workspace-brand/validation.js";

const paramsSchema = z.object({
  workspaceId: z.uuid(),
  assetId: z.uuid().optional(),
});
export function registerWorkspaceBrandRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  brand: WorkspaceBrandService,
  assets: WorkspaceAssetService,
) {
  const handler =
    (
      action: (
        request: FastifyRequest,
        reply: FastifyReply,
        userId: string,
        params: z.infer<typeof paramsSchema>,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await getRequestUser(auth, request);
      if (!user)
        return reply
          .status(401)
          .send({
            error: {
              statusCode: 401,
              code: "UNAUTHENTICATED",
              message: "Unauthorized",
            },
          });
      try {
        return await action(
          request,
          reply,
          user.id,
          paramsSchema.parse(request.params),
        );
      } catch (error) {
        let statusCode: number, code: string, message: string;
        if (error instanceof z.ZodError) {
          statusCode = 400;
          code = "INVALID_BRAND_REQUEST";
          message = error.issues[0]?.message ?? "Invalid brand settings";
        } else if (
          error instanceof WorkspaceAccessError ||
          error instanceof WorkspaceAssetError
        ) {
          ({ statusCode, code, message } = error);
        } else if (error instanceof StorageQuotaError) {
          statusCode = 413;
          code = "STORAGE_QUOTA_EXCEEDED";
          message = "Storage quota exceeded";
        } else throw error;
        return reply
          .status(statusCode)
          .send({ error: { statusCode, code, message } });
      }
    };
  app.get(
    "/api/workspaces/:workspaceId/brand",
    handler(async (_request, reply, userId, { workspaceId }) =>
      reply.send({ profile: await brand.get(workspaceId, userId) }),
    ),
  );
  app.put(
    "/api/workspaces/:workspaceId/brand",
    handler(async (request, reply, userId, { workspaceId }) =>
      reply.send({
        profile: await brand.save(
          workspaceId,
          userId,
          workspaceBrandSchema.parse(request.body),
        ),
      }),
    ),
  );
  app.post(
    "/api/workspaces/:workspaceId/assets",
    handler(async (request, reply, userId, { workspaceId }) => {
      await assets.requireWorkspace(workspaceId, userId);
      const file = await request.file({
        limits: { fileSize: assetMaxBytes, files: 1, fields: 0 },
      });
      if (!file)
        throw new WorkspaceAssetError(400, "IMAGE_REQUIRED", "Choose an image");
      return reply
        .status(201)
        .send({
          asset: await assets.upload(
            workspaceId,
            userId,
            await file.toBuffer(),
          ),
        });
    }),
  );
  app.get(
    "/api/workspaces/:workspaceId/assets/:assetId",
    handler(async (_request, reply, userId, { workspaceId, assetId }) => {
      const object = await assets.read(workspaceId, userId, assetId!);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type(object.contentType)
        .send(object.body);
    }),
  );
  app.delete(
    "/api/workspaces/:workspaceId/assets/:assetId",
    handler(async (_request, reply, userId, { workspaceId, assetId }) => {
      await assets.removeUnused(workspaceId, userId, assetId!);
      return reply.status(204).send();
    }),
  );
}
