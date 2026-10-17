import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@opensuite/db";
import type { WorkspaceService } from "../workspaces/service.js";
import { WorkspaceAccessError } from "../workspaces/service.js";
import { ObjectNotFoundError, type ObjectStorage } from "../storage/types.js";
import type { StorageAccountingService } from "../storage-accounting/service.js";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENTS_PER_MESSAGE,
  STAGED_ATTACHMENT_TTL_MS,
  verifyChatAttachmentBytes,
} from "./validation.js";

export class ChatAttachmentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly stage?: string,
  ) {
    super(message);
  }
}

export type ChatAttachmentDto = {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly kind: "file" | "text";
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: "staged" | "bound" | "deleted";
  readonly createdAt: string;
  readonly boundAt: string | null;
};

function toDto(row: typeof schema.chatAttachment.$inferSelect): ChatAttachmentDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    messageId: row.messageId,
    kind: row.kind,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    boundAt: row.boundAt?.toISOString() ?? null,
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createChatAttachmentService(
  db: Db,
  storage: ObjectStorage,
  workspaces: Pick<WorkspaceService, "getOwned">,
  accounting: StorageAccountingService,
  options: { maxBytes?: number; stagedTtlMs?: number } = {},
) {
  const maxBytes = options.maxBytes ?? CHAT_ATTACHMENT_MAX_BYTES;
  const stagedTtlMs = options.stagedTtlMs ?? STAGED_ATTACHMENT_TTL_MS;

  async function requireWorkspace(workspaceId: string, userId: string) {
    if (!(await workspaces.getOwned(workspaceId, userId))) {
      throw new WorkspaceAccessError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }
  }

  async function lockWorkspace(tx: Db, workspaceId: string, userId: string) {
    await tx.execute(sql`select id from ${schema.workspace} where id = ${workspaceId} for update`);
    await requireWorkspace(workspaceId, userId);
  }

  async function requireOwnedThread(
    tx: Db,
    threadId: string,
    workspaceId: string,
    userId: string,
  ) {
    const [thread] = await tx
      .select({
        id: schema.agentThread.id,
        workspaceId: schema.agentThread.workspaceId,
      })
      .from(schema.agentThread)
      .innerJoin(schema.workspace, eq(schema.agentThread.workspaceId, schema.workspace.id))
      .where(
        and(
          eq(schema.agentThread.id, threadId),
          eq(schema.agentThread.workspaceId, workspaceId),
          eq(schema.workspace.ownerUserId, userId),
          isNull(schema.agentThread.archivedAt),
        ),
      )
      .limit(1);
    if (!thread) {
      throw new ChatAttachmentError(404, "THREAD_NOT_FOUND", "Agent thread not found");
    }
    return thread;
  }

  async function getOwnedRow(
    tx: Db,
    workspaceId: string,
    userId: string,
    attachmentId: string,
  ) {
    const [row] = await tx
      .select()
      .from(schema.chatAttachment)
      .where(
        and(
          eq(schema.chatAttachment.id, attachmentId),
          eq(schema.chatAttachment.workspaceId, workspaceId),
          eq(schema.chatAttachment.ownerUserId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function deleteObjectBestEffort(storageKey: string) {
    try {
      await storage.deleteObject(storageKey);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }

  async function getBound(input: { workspaceId: string; userId: string; threadId: string; attachmentId: string }) {
    await requireWorkspace(input.workspaceId, input.userId);
    await requireOwnedThread(db, input.threadId, input.workspaceId, input.userId);
    const row = await getOwnedRow(db, input.workspaceId, input.userId, input.attachmentId);
    if (!row || row.status !== "bound" || row.threadId !== input.threadId || !row.messageId) {
      throw new ChatAttachmentError(404, "ATTACHMENT_NOT_FOUND", "Bound attachment not found in this chat");
    }
    return row;
  }

  /** Soft-delete one attachment: drop bytes, release quota, block future reads. */
  async function markDeleted(tx: Db, row: typeof schema.chatAttachment.$inferSelect) {
    if (row.status === "deleted") return;
    await deleteObjectBestEffort(row.storageKey);
    await deleteObjectBestEffort(`${row.storageKey}/extraction.json`);
    await tx
      .update(schema.chatAttachment)
      .set({
        status: "deleted",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.chatAttachment.id, row.id));
    await accounting.release(tx, row.ownerUserId, row.sizeBytes);
  }

  return {
    requireWorkspace,

    async getBound(input: Parameters<typeof getBound>[0]) {
      return toDto(await getBound(input));
    },

    async readExtraction(input: Parameters<typeof getBound>[0]): Promise<Buffer | null> {
      const row = await getBound(input);
      try {
        const object = await storage.getObject(`${row.storageKey}/extraction.json`);
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => object.body.destroy(new ChatAttachmentError(503, "EXTRACTION_TIMEOUT", "Cached extraction read exceeded 10 seconds", true, "cache_read")), 10_000);
        try {
          for await (const chunk of object.body) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) return null;
            chunks.push(Buffer.from(chunk));
          }
        } finally {
          clearTimeout(timer);
          object.body.destroy();
        }
        await getBound(input);
        return Buffer.concat(chunks);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) return null;
        throw error;
      }
    },

    async saveExtraction(input: Parameters<typeof getBound>[0] & { bytes: Buffer }) {
      const row = await getBound(input);
      if (input.bytes.length > 4 * 1024 * 1024) throw new ChatAttachmentError(400, "EXTRACTION_LIMIT", "Extracted attachment is too large");
      const key = `${row.storageKey}/extraction.json`;
      await storage.putObject({ key, body: input.bytes, contentType: "application/json" });
      try {
        await getBound(input);
      } catch (error) {
        await deleteObjectBestEffort(key);
        throw error;
      }
    },

    async upload(input: {
      workspaceId: string;
      userId: string;
      filename: string;
      bytes: Buffer;
      threadId?: string | null;
      kind?: "file" | "text";
    }): Promise<ChatAttachmentDto> {
      await requireWorkspace(input.workspaceId, input.userId);
      // Opportunistic cleanup so abandoned staged uploads do not accumulate.
      await this.expireStaged({ workspaceId: input.workspaceId, userId: input.userId }).catch(
        (error) => console.error("[chat-attachments] expire during upload failed", error),
      );

      if (input.bytes.length > maxBytes) {
        throw new ChatAttachmentError(
          400,
          "ATTACHMENT_TOO_LARGE",
          `Attachments must be at most ${Math.floor(maxBytes / (1024 * 1024))} MB`,
        );
      }
      const verified = verifyChatAttachmentBytes(input.filename, input.bytes);
      if (!verified) {
        throw new ChatAttachmentError(
          400,
          "UNSUPPORTED_ATTACHMENT",
          "Supported attachments: DOCX, PDF, TXT, Markdown, PNG, JPEG",
        );
      }
      const kind = input.kind ?? "file";
      if (kind === "text" && verified.mediaType !== "text/plain" && verified.mediaType !== "text/markdown") {
        throw new ChatAttachmentError(400, "UNSUPPORTED_ATTACHMENT", "Text resources must be TXT or Markdown");
      }

      if (input.threadId) {
        await requireOwnedThread(db, input.threadId, input.workspaceId, input.userId);
      }

      const id = randomUUID();
      const storageKey = `workspaces/${input.workspaceId}/chat-attachments/${id}`;
      const sha256 = sha256Hex(input.bytes);
      try {
        await storage.putObject({
          key: storageKey,
          body: input.bytes,
          contentType: verified.mediaType,
        });
        const [row] = await db.transaction(async (tx) => {
          await lockWorkspace(tx, input.workspaceId, input.userId);
          if (input.threadId) {
            await requireOwnedThread(tx, input.threadId, input.workspaceId, input.userId);
          }
          await accounting.reserve(tx, input.userId, input.bytes.length);
          return tx
            .insert(schema.chatAttachment)
            .values({
              id,
              workspaceId: input.workspaceId,
              ownerUserId: input.userId,
              threadId: input.threadId ?? null,
              kind,
              filename: verified.filename,
              mediaType: verified.mediaType,
              sizeBytes: input.bytes.length,
              sha256,
              storageKey,
              status: "staged",
            })
            .returning();
        });
        if (!row) throw new Error("Failed to create chat attachment");
        return toDto(row);
      } catch (error) {
        await storage
          .deleteObject(storageKey)
          .catch((cleanupError) =>
            console.error("[chat-attachments] upload cleanup failed", cleanupError),
          );
        throw error;
      }
    },

    async list(input: {
      workspaceId: string;
      userId: string;
      threadId?: string;
      status?: "staged" | "bound";
      limit?: number;
      offset?: number;
      mentionedIn?: string;
    }): Promise<ChatAttachmentDto[]> {
      await requireWorkspace(input.workspaceId, input.userId);
      if (input.threadId) await requireOwnedThread(db, input.threadId, input.workspaceId, input.userId);
      const limit = Math.min(50, Math.max(1, input.limit ?? 50));
      const rows = await db
        .select()
        .from(schema.chatAttachment)
        .where(
          and(
            eq(schema.chatAttachment.workspaceId, input.workspaceId),
            eq(schema.chatAttachment.ownerUserId, input.userId),
            input.mentionedIn !== undefined
              ? sql`(position(lower(${schema.chatAttachment.filename}) in lower(${input.mentionedIn})) > 0 or position(${schema.chatAttachment.id}::text in ${input.mentionedIn}) > 0)`
              : undefined,
            input.threadId
              ? eq(schema.chatAttachment.threadId, input.threadId)
              : undefined,
            input.status
              ? eq(schema.chatAttachment.status, input.status)
              : inArray(schema.chatAttachment.status, ["staged", "bound"]),
          ),
        )
        .orderBy(sql`${schema.chatAttachment.createdAt} desc`, sql`${schema.chatAttachment.id} desc`)
        .offset(Math.max(0, input.offset ?? 0))
        .limit(limit);
      return rows.map(toDto);
    },

    async get(input: {
      workspaceId: string;
      userId: string;
      attachmentId: string;
    }): Promise<ChatAttachmentDto> {
      await requireWorkspace(input.workspaceId, input.userId);
      const row = await getOwnedRow(db, input.workspaceId, input.userId, input.attachmentId);
      if (!row || row.status === "deleted") {
        throw new ChatAttachmentError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      return toDto(row);
    },

    async read(input: {
      workspaceId: string;
      userId: string;
      attachmentId: string;
    }) {
      const meta = await this.get(input);
      const row = await getOwnedRow(db, input.workspaceId, input.userId, input.attachmentId);
      if (!row || row.status === "deleted") {
        throw new ChatAttachmentError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      try {
        const object = await storage.getObject(row.storageKey);
        return {
          ...meta,
          body: object.body,
          contentLength: object.contentLength,
        };
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          throw new ChatAttachmentError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
        }
        throw error;
      }
    },

    async remove(input: {
      workspaceId: string;
      userId: string;
      attachmentId: string;
    }): Promise<void> {
      await requireWorkspace(input.workspaceId, input.userId);
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, input.workspaceId, input.userId);
        const row = await getOwnedRow(tx, input.workspaceId, input.userId, input.attachmentId);
        if (!row || row.status === "deleted") {
          throw new ChatAttachmentError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
        }
        await markDeleted(tx, row);
      });
    },

    /**
     * Claim staged IDs (and allow same-thread bound references) for a new message.
     * Must run inside the message-creation transaction.
     */
    async bindToMessage(
      input: {
        workspaceId: string;
        userId: string;
        threadId: string;
        messageId: string;
        attachmentIds: readonly string[];
      },
      tx: Db = db,
    ): Promise<ChatAttachmentDto[]> {
      const ids = [...new Set(input.attachmentIds)];
      if (ids.length === 0) return [];
      if (ids.length > CHAT_ATTACHMENTS_PER_MESSAGE) {
        throw new ChatAttachmentError(
          400,
          "TOO_MANY_ATTACHMENTS",
          `At most ${CHAT_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        );
      }

      await requireOwnedThread(tx, input.threadId, input.workspaceId, input.userId);
      const rows = await tx
        .select()
        .from(schema.chatAttachment)
        .where(
          and(
            inArray(schema.chatAttachment.id, ids),
            eq(schema.chatAttachment.workspaceId, input.workspaceId),
            eq(schema.chatAttachment.ownerUserId, input.userId),
          ),
        );
      if (rows.length !== ids.length) {
        throw new ChatAttachmentError(
          400,
          "INVALID_ATTACHMENTS",
          "One or more attachments are missing or inaccessible",
        );
      }

      const byId = new Map(rows.map((row) => [row.id, row]));
      const bound: ChatAttachmentDto[] = [];
      for (const id of ids) {
        const row = byId.get(id)!;
        if (row.status === "deleted") {
          throw new ChatAttachmentError(400, "INVALID_ATTACHMENTS", "Attachment was deleted");
        }
        if (row.status === "staged") {
          if (row.threadId != null && row.threadId !== input.threadId) {
            throw new ChatAttachmentError(
              400,
              "INVALID_ATTACHMENTS",
              "Attachment belongs to another thread",
            );
          }
          const [updated] = await tx
            .update(schema.chatAttachment)
            .set({
              status: "bound",
              threadId: input.threadId,
              messageId: input.messageId,
              boundAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.chatAttachment.id, id),
                eq(schema.chatAttachment.status, "staged"),
              ),
            )
            .returning();
          if (!updated) {
            throw new ChatAttachmentError(
              409,
              "ATTACHMENT_NOT_READY",
              "Attachment is not ready to send",
            );
          }
          bound.push(toDto(updated));
          continue;
        }
        if (row.status === "bound") {
          if (row.threadId !== input.threadId) {
            throw new ChatAttachmentError(
              400,
              "INVALID_ATTACHMENTS",
              "Attachment belongs to another thread",
            );
          }
          bound.push(toDto(row));
          continue;
        }
        throw new ChatAttachmentError(400, "INVALID_ATTACHMENTS", "Attachment is not ready");
      }
      return bound;
    },

    async metadataForIds(input: {
      workspaceId: string;
      userId: string;
      attachmentIds: readonly string[];
    }): Promise<ChatAttachmentDto[]> {
      const ids = [...new Set(input.attachmentIds)];
      if (ids.length === 0) return [];
      await requireWorkspace(input.workspaceId, input.userId);
      const rows = await db
        .select()
        .from(schema.chatAttachment)
        .where(
          and(
            inArray(schema.chatAttachment.id, ids),
            eq(schema.chatAttachment.workspaceId, input.workspaceId),
            eq(schema.chatAttachment.ownerUserId, input.userId),
            inArray(schema.chatAttachment.status, ["staged", "bound"]),
          ),
        );
      const byId = new Map(rows.map((row) => [row.id, toDto(row)]));
      return ids.map((id) => byId.get(id)).filter((row): row is ChatAttachmentDto => Boolean(row));
    },

    async expireStaged(input?: { workspaceId?: string; userId?: string }): Promise<number> {
      const cutoff = new Date(Date.now() - stagedTtlMs);
      const candidates = await db
        .select()
        .from(schema.chatAttachment)
        .where(
          and(
            eq(schema.chatAttachment.status, "staged"),
            lt(schema.chatAttachment.createdAt, cutoff),
            input?.workspaceId
              ? eq(schema.chatAttachment.workspaceId, input.workspaceId)
              : undefined,
            input?.userId ? eq(schema.chatAttachment.ownerUserId, input.userId) : undefined,
          ),
        )
        .limit(100);
      let expired = 0;
      for (const row of candidates) {
        await db.transaction(async (tx) => {
          await lockWorkspace(tx, row.workspaceId, row.ownerUserId);
          const [fresh] = await tx
            .select()
            .from(schema.chatAttachment)
            .where(
              and(
                eq(schema.chatAttachment.id, row.id),
                eq(schema.chatAttachment.status, "staged"),
              ),
            )
            .limit(1);
          if (!fresh) return;
          await markDeleted(tx, fresh);
          expired += 1;
        });
      }
      return expired;
    },
  };
}

export type ChatAttachmentService = ReturnType<typeof createChatAttachmentService>;
