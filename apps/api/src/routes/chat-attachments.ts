import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import { WorkspaceAccessError } from "../workspaces/service.js";
import { StorageQuotaError } from "../storage-accounting/service.js";
import {
  ChatAttachmentError,
  type ChatAttachmentService,
} from "../chat-attachments/service.js";
import { CHAT_ATTACHMENT_MAX_BYTES } from "../chat-attachments/validation.js";

const paramsSchema = z.object({
  workspaceId: z.uuid(),
  attachmentId: z.uuid().optional(),
});

const listQuerySchema = z.object({
  threadId: z.uuid().optional(),
  status: z.enum(["staged", "bound"]).optional(),
});

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerChatAttachmentRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  attachments: ChatAttachmentService,
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
      if (!user) {
        return reply.status(401).send({
          error: {
            statusCode: 401,
            code: "UNAUTHENTICATED",
            message: "Unauthorized",
          },
        });
      }
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
          code = "INVALID_ATTACHMENT_REQUEST";
          message = error.issues[0]?.message ?? "Invalid attachment request";
        } else if (
          error instanceof WorkspaceAccessError ||
          error instanceof ChatAttachmentError
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

  app.post(
    "/api/workspaces/:workspaceId/chat-attachments",
    handler(async (request, reply, userId, { workspaceId }) => {
      await attachments.requireWorkspace(workspaceId, userId);
      const query = z
        .object({ threadId: z.uuid().optional() })
        .parse(request.query);
      const file = await request.file({
        limits: { fileSize: CHAT_ATTACHMENT_MAX_BYTES, files: 1, fields: 2 },
      });
      if (!file) {
        throw new ChatAttachmentError(400, "FILE_REQUIRED", "Choose a file");
      }
      const fieldThread = (file.fields?.threadId as { value?: string } | undefined)?.value;
      const threadId =
        fieldThread && z.uuid().safeParse(fieldThread).success
          ? fieldThread
          : query.threadId;

      const attachment = await attachments.upload({
        workspaceId,
        userId,
        filename: file.filename || "attachment",
        bytes: await file.toBuffer(),
        ...(threadId ? { threadId } : {}),
      });
      return reply.status(201).send({ attachment });
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/chat-attachments",
    handler(async (request, reply, userId, { workspaceId }) => {
      const query = listQuerySchema.parse(request.query);
      return reply.send({
        attachments: await attachments.list({
          workspaceId,
          userId,
          ...(query.threadId ? { threadId: query.threadId } : {}),
          ...(query.status ? { status: query.status } : {}),
        }),
      });
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/chat-attachments/:attachmentId",
    handler(async (_request, reply, userId, { workspaceId, attachmentId }) => {
      const object = await attachments.read({
        workspaceId,
        userId,
        attachmentId: attachmentId!,
      });
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", contentDisposition(object.filename))
        .type(object.mediaType)
        .send(object.body);
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/chat-attachments/:attachmentId/meta",
    handler(async (_request, reply, userId, { workspaceId, attachmentId }) => {
      return reply.send({
        attachment: await attachments.get({
          workspaceId,
          userId,
          attachmentId: attachmentId!,
        }),
      });
    }),
  );

  app.delete(
    "/api/workspaces/:workspaceId/chat-attachments/:attachmentId",
    handler(async (_request, reply, userId, { workspaceId, attachmentId }) => {
      await attachments.remove({
        workspaceId,
        userId,
        attachmentId: attachmentId!,
      });
      return reply.status(204).send();
    }),
  );
}
