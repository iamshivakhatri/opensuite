import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  toAgentMessageDto,
  toAgentRunDto,
  toAgentThreadDto,
} from "../agent/dto.js";
import { AgentExecutionError } from "../agent/execution.js";
import {
  AgentPersistenceError,
  type AgentPersistenceService,
} from "../agent/persistence.js";
import {
  formatSseComment,
  formatSseEvent,
  type AgentRunManager,
  type LiveEvent,
} from "../agent/run-manager.js";
import type { AgentExecutionLeaseService } from "../agent/execution-lease.js";
import { getRequestUser, type SessionAuth } from "../auth/session.js";
const WorkspaceIdParams = z.object({
  workspaceId: z.uuid("workspaceId must be a UUID"),
});

const ThreadIdParams = z.object({
  threadId: z.uuid("threadId must be a UUID"),
});

const RunIdParams = z.object({
  runId: z.uuid("runId must be a UUID"),
});

/** GET /messages default/max page size (C6) — one route-level knob, not configurable app-wide. */
const DEFAULT_MESSAGES_PAGE_SIZE = 50;
const MAX_MESSAGES_PAGE_SIZE = 100;

const ListMessagesQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1, "limit must be at least 1")
      .max(MAX_MESSAGES_PAGE_SIZE, `limit must be at most ${MAX_MESSAGES_PAGE_SIZE}`)
      .optional(),
    beforeCreatedAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "beforeCreatedAt must be a valid ISO timestamp",
      })
      .optional(),
    beforeId: z.uuid("beforeId must be a UUID").optional(),
  })
  .refine(
    (value) =>
      (value.beforeCreatedAt === undefined) === (value.beforeId === undefined),
    { message: "beforeCreatedAt and beforeId must be supplied together" },
  );

const CreateThreadBody = z.object({
  title: z
    .string()
    .trim()
    .max(200, "Title must be at most 200 characters")
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value)),
});

const CreateRunBody = z.object({
  instruction: z
    .string()
    .trim()
    .min(1, "Instruction is required")
    .max(20_000, "Instruction must be at most 20000 characters"),
  documentIds: z
    .array(z.uuid("documentIds must be UUIDs"))
    .max(20, "At most 20 tagged documents")
    .optional(),
});

const SSE_HEARTBEAT_MS = 15_000;

function unauthenticated() {
  return {
    error: {
      statusCode: 401 as const,
      message: "Unauthorized",
      code: "UNAUTHENTICATED" as const,
    },
  };
}

export interface AgentRouteDeps {
  readonly auth: SessionAuth;
  readonly persistence: AgentPersistenceService;
  readonly runManager: AgentRunManager;
  readonly lease?: AgentExecutionLeaseService;
  /** Required on hijacked SSE — reply.hijack bypasses @fastify/cors. */
  readonly webOrigin: string;
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Workspace agent threads, asynchronous runs, and SSE updates.
 */
export function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  const { auth, persistence, runManager, lease, webOrigin } = deps;

  app.get(
    "/api/workspaces/:workspaceId/agent/threads",
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

      try {
        const threads = await persistence.listThreadsForWorkspace({
          workspaceId: params.data.workspaceId,
          ownerUserId: user.id,
          documentId: null,
          includeArchived: false,
        });
        return reply.send({
          threads: threads.map(toAgentThreadDto),
        });
      } catch (error) {
        return mapPersistenceError(reply, error);
      }
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/agent/threads",
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

      const body = CreateThreadBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message: body.error.issues[0]?.message ?? "Invalid thread title",
            code: "INVALID_AGENT_THREAD_TITLE",
          },
        });
      }

      try {
        const thread = await persistence.createThread({
          workspaceId: params.data.workspaceId,
          ownerUserId: user.id,
          documentId: null,
          createdByUserId: user.id,
          title: body.data.title,
        });
        return reply.status(201).send({ thread: toAgentThreadDto(thread) });
      } catch (error) {
        return mapPersistenceError(reply, error);
      }
    },
  );

  app.get("/api/agent/threads/:threadId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = ThreadIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid thread id",
          code: "INVALID_THREAD_ID",
        },
      });
    }

    const thread = await persistence.getOwnedThread({
      threadId: params.data.threadId,
      ownerUserId: user.id,
    });
    if (!thread) {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Agent thread not found",
          code: "THREAD_NOT_FOUND",
        },
      });
    }

    return reply.send({ thread: toAgentThreadDto(thread) });
  });

  app.get("/api/agent/threads/:threadId/messages", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = ThreadIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid thread id",
          code: "INVALID_THREAD_ID",
        },
      });
    }

    const query = ListMessagesQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: query.error.issues[0]?.message ?? "Invalid query parameters",
          code: "INVALID_MESSAGES_QUERY",
        },
      });
    }

    const limit = query.data.limit ?? DEFAULT_MESSAGES_PAGE_SIZE;
    const before =
      query.data.beforeCreatedAt !== undefined && query.data.beforeId !== undefined
        ? { createdAt: query.data.beforeCreatedAt, id: query.data.beforeId }
        : null;

    try {
      const page = await persistence.listMessagesPageForThread({
        threadId: params.data.threadId,
        ownerUserId: user.id,
        limit,
        before,
      });
      const latestRun = await persistence.getLatestRunForThread({
        threadId: params.data.threadId,
        ownerUserId: user.id,
      });
      return reply.send({
        messages: page.messages.map(toAgentMessageDto),
        page: {
          hasMore: page.hasMore,
          ...(page.hasMore && page.oldestCursor
            ? { oldestCursor: page.oldestCursor }
            : {}),
        },
        latestRun: latestRun ? toAgentRunDto(latestRun) : null,
      });
    } catch (error) {
      return mapPersistenceError(reply, error);
    }
  });

  app.post("/api/agent/threads/:threadId/runs", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = ThreadIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid thread id",
          code: "INVALID_THREAD_ID",
        },
      });
    }

    const body = CreateRunBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: body.error.issues[0]?.message ?? "Invalid instruction",
          code: "INVALID_AGENT_INSTRUCTION",
        },
      });
    }

    try {
      const started = await runManager.startRun({
        userId: user.id,
        threadId: params.data.threadId,
        instruction: body.data.instruction,
        ...(body.data.documentIds !== undefined
          ? { documentIds: body.data.documentIds }
          : {}),
      });
      return reply.status(202).send({
        run: toAgentRunDto(started.run),
      });
    } catch (error) {
      return mapExecutionError(reply, error, {
        runManager,
        userId: user.id,
      });
    }
  });

  app.get("/api/agent/runs/:runId", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = RunIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid run id",
          code: "INVALID_RUN_ID",
        },
      });
    }

    try {
      const run = await persistence.getRun({
        runId: params.data.runId,
        ownerUserId: user.id,
      });
      if (!run) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Agent run not found",
            code: "RUN_NOT_FOUND",
          },
        });
      }

      return reply.send({
        run: toAgentRunDto(run),
        steps: [],
      });
    } catch (error) {
      return mapPersistenceError(reply, error);
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = RunIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid run id",
          code: "INVALID_RUN_ID",
        },
      });
    }

    try {
      const run = await persistence.getRun({
        runId: params.data.runId,
        ownerUserId: user.id,
      });
      if (!run) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Agent run not found",
            code: "RUN_NOT_FOUND",
          },
        });
      }

      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        const cancelled = runManager.cancel({
          runId: run.id,
          ownerUserId: user.id,
        });
        if (cancelled) {
          await runManager.waitForRun(run.id);
        }
      }

      const current = await persistence.getRun({
        runId: run.id,
        ownerUserId: user.id,
      });
      if (!current) {
        return reply.status(404).send({
          error: {
            statusCode: 404,
            message: "Agent run not found",
            code: "RUN_NOT_FOUND",
          },
        });
      }

      return reply.send({
        run: toAgentRunDto(current),
        steps: [],
      });
    } catch (error) {
      return mapPersistenceError(reply, error);
    }
  });

  app.get("/api/agent/runs/:runId/events", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const params = RunIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: params.error.issues[0]?.message ?? "Invalid run id",
          code: "INVALID_RUN_ID",
        },
      });
    }

    const run = await persistence.getRun({
      runId: params.data.runId,
      ownerUserId: user.id,
    });
    if (!run) {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Agent run not found",
          code: "RUN_NOT_FOUND",
        },
      });
    }

    // reply.hijack() skips @fastify/cors — without these headers the browser
    // blocks reading the stream (CORS) while the server still holds the socket.
    const requestOrigin = request.headers.origin;
    const allowOrigin =
      typeof requestOrigin === "string" && requestOrigin === webOrigin
        ? requestOrigin
        : webOrigin;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
    // Push headers + first bytes immediately (some proxies buffer until flush).
    const raw = reply.raw as typeof reply.raw & {
      flushHeaders?: () => void;
      flush?: () => void;
    };
    raw.flushHeaders?.();
    reply.raw.socket?.setNoDelay?.(true);
    reply.raw.write(formatSseComment("connected"));
    raw.flush?.();

    const terminalStatuses = TERMINAL_RUN_STATUSES;
    let cleaned = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const cleanup = (reason = "cleanup") => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      request.raw.off("close", onRequestClose);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    const onRequestClose = () => {
      cleanup("client-close");
    };

    const writeEvent = (event: LiveEvent) => {
      if (cleaned || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(formatSseEvent(event));
      // Avoid OS/TCP buffering so message.delta reaches the browser promptly.
      const raw = reply.raw as typeof reply.raw & { flush?: () => void };
      raw.flush?.();
      if (
        event.type === "agent.completed" ||
        event.type === "agent.failed" ||
        event.type === "agent.cancelled"
      ) {
        cleanup(`terminal:${event.type}`);
      }
    };

    const sub = runManager.subscribeEvents({
      runId: run.id,
      ownerUserId: user.id,
      onEvent: writeEvent,
    });

    if (sub.status === "not_found") {
        reply.raw.write(
          formatSseEvent({
            id: 0,
            runId: run.id,
            type: "agent.failed",
            at: new Date().toISOString(),
            data: { code: "RUN_NOT_FOUND", message: "Agent run not found" },
          }),
        );
        cleanup("not_found");
        return;
      }

      if (sub.status === "not_live") {
      // Live hub gone (API restart / process crash). If durable status is still
      // non-terminal, mark the run failed and emit a terminal event so the UI
      // stops reconnecting / polling.
      if (
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "cancelled"
      ) {
        let durable = run;
        try {
          durable = await persistence.updateRunStatus({
            runId: run.id,
            ownerUserId: user.id,
            status: "failed",
            errorCode: "RUN_ABANDONED",
            errorMessage:
              "Agent run is no longer live (process exit or restart)",
          });
          // Lease outlives the in-memory run after crash/restart; drop it when
          // nothing else is live for this user so new runs are not blocked.
          if (lease && !runManager.hasLiveForOwner(user.id)) {
            await lease.releaseUser(user.id).catch(() => undefined);
          }
        } catch {
          const refreshed = await persistence.getRun({
            runId: run.id,
            ownerUserId: user.id,
          });
          if (refreshed) {
            durable = refreshed;
          }
        }
        reply.raw.write(
          formatSseEvent({
            id: 0,
            runId: durable.id,
            type: "agent.failed",
            at: new Date().toISOString(),
            data: {
              status: durable.status,
              live: false,
              code: durable.errorCode ?? "RUN_ABANDONED",
              message:
                durable.errorMessage ??
                "Agent run is no longer live (process exit or restart)",
            },
          }),
        );
        cleanup("not_live_abandoned");
        return;
      }
      const type =
        run.status === "failed"
          ? "agent.failed"
          : run.status === "cancelled"
            ? "agent.cancelled"
            : "agent.completed";
      reply.raw.write(
        formatSseEvent({
          id: 0,
          runId: run.id,
          type,
          at: new Date().toISOString(),
          data: {
            status: run.status,
            live: false,
            ...(run.status === "failed"
              ? {
                  code: "AGENT_EXECUTION_FAILED",
                  message: "Agent run is no longer live",
                }
              : {}),
          },
        }),
      );
      cleanup("not_live_terminal");
      return;
    }

    unsubscribe = sub.unsubscribe;

    // If durable status is already terminal and we somehow still subscribed,
    // the hub should still deliver agent.* terminal from buffer/grace.
    if (terminalStatuses.has(run.status) && !runManager.isLive(run.id)) {
      cleanup("already_terminal");
      return;
    }

    heartbeat = setInterval(() => {
      if (cleaned || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(formatSseComment("heartbeat"));
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    request.raw.on("close", onRequestClose);
  });
}

function mapPersistenceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentPersistenceError) {
    if (error.code === "THREAD_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Agent thread not found",
          code: "THREAD_NOT_FOUND",
        },
      });
    }
    if (error.code === "RUN_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Agent run not found",
          code: "RUN_NOT_FOUND",
        },
      });
    }
    if (error.code === "DOCUMENT_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Document not found",
          code: "DOCUMENT_NOT_FOUND",
        },
      });
    }
    if (error.code === "WORKSPACE_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Workspace not found",
          code: "WORKSPACE_NOT_FOUND",
        },
      });
    }
  }
  throw error;
}

function mapExecutionError(
  reply: FastifyReply,
  error: unknown,
  context?: {
    runManager: AgentRunManager;
    userId: string;
  },
) {
  if (error instanceof AgentExecutionError) {
    if (error.code === "THREAD_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Agent thread not found",
          code: "THREAD_NOT_FOUND",
        },
      });
    }
    if (error.code === "DOCUMENT_NOT_FOUND") {
      return reply.status(404).send({
        error: {
          statusCode: 404,
          message: "Document not found",
          code: "DOCUMENT_NOT_FOUND",
        },
      });
    }
    if (error.code === "AGENT_EXECUTION_BUSY") {
      const live = context?.runManager.getLiveForOwner(context.userId) ?? null;
      return reply.status(409).send({
        error: {
          statusCode: 409,
          message: "Another agent execution is already active.",
          code: "AGENT_EXECUTION_BUSY",
          ...(live
            ? {
                activeRunId: live.runId,
                activeThreadId: live.threadId,
              }
            : {}),
        },
      });
    }
    if (
      error.code === "AI_CONFIGURATION_INVALID" ||
      error.code === "AGENT_EXECUTION_FAILED" ||
      error.code === "AGENT_PERSISTENCE_FAILED"
    ) {
      return reply.status(error.code === "AI_CONFIGURATION_INVALID" ? 409 : 500).send({
        error: {
          statusCode: error.code === "AI_CONFIGURATION_INVALID" ? 409 : 500,
          message: error.code === "AI_CONFIGURATION_INVALID" ? error.message : "Agent run failed",
          code: error.code,
        },
      });
    }
  }
  throw error;
}
