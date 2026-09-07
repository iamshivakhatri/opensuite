import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  toAgentMessageDto,
  toAgentRunDto,
  toAgentStepDto,
  toAgentThreadDto,
} from "../agent/dto.js";
import {
  AgentExecutionError,
  type AgentExecutionService,
} from "../agent/execution.js";
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
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import {
  DocumentAccessError,
  type DocumentService,
} from "../documents/service.js";

const DocumentIdParams = z.object({
  documentId: z.uuid("documentId must be a UUID"),
});

const WorkspaceIdParams = z.object({
  workspaceId: z.uuid("workspaceId must be a UUID"),
});

const ThreadIdParams = z.object({
  threadId: z.uuid("threadId must be a UUID"),
});

const RunIdParams = z.object({
  runId: z.uuid("runId must be a UUID"),
});

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
  readonly documents: DocumentService;
  readonly persistence: AgentPersistenceService;
  readonly execution: AgentExecutionService;
  readonly runManager: AgentRunManager;
  /** Required on hijacked SSE — reply.hijack bypasses @fastify/cors. */
  readonly webOrigin: string;
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Workspace-scoped agent threads + document-scoped legacy routes + async run + SSE.
 * POST /runs returns 202 quickly; progress via SSE; recovery via GET /runs.
 */
export function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  const { auth, documents, persistence, runManager, webOrigin } = deps;

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

  app.get(
    "/api/documents/:documentId/agent/threads",
    async (request, reply) => {
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

      let document;
      try {
        document = await documents.getOwnedDocument({
          documentId: params.data.documentId,
          ownerUserId: user.id,
        });
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

      try {
        const threads = await persistence.listThreadsForWorkspace({
          workspaceId: document.workspaceId,
          ownerUserId: user.id,
          documentId: document.id,
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
    "/api/documents/:documentId/agent/threads",
    async (request, reply) => {
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

      let document;
      try {
        document = await documents.getOwnedDocument({
          documentId: params.data.documentId,
          ownerUserId: user.id,
        });
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

      try {
        const thread = await persistence.createThread({
          workspaceId: document.workspaceId,
          ownerUserId: user.id,
          documentId: document.id,
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

    try {
      const messages = await persistence.listMessagesForThread({
        threadId: params.data.threadId,
        ownerUserId: user.id,
      });
      const latestRun = await persistence.getLatestRunForThread({
        threadId: params.data.threadId,
        ownerUserId: user.id,
      });
      return reply.send({
        messages: messages.map(toAgentMessageDto),
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
      return mapExecutionError(reply, error);
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

      const steps = await persistence.listStepsForRun({
        runId: run.id,
        ownerUserId: user.id,
      });

      return reply.send({
        run: toAgentRunDto(run),
        steps: steps.map(toAgentStepDto),
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

      const steps = await persistence.listStepsForRun({
        runId: current.id,
        ownerUserId: user.id,
      });

      return reply.send({
        run: toAgentRunDto(current),
        steps: steps.map(toAgentStepDto),
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

    const cleanup = () => {
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
      request.raw.off("close", cleanup);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
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
        cleanup();
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
      cleanup();
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
        cleanup();
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
      cleanup();
      return;
    }

    unsubscribe = sub.unsubscribe;

    // If durable status is already terminal and we somehow still subscribed,
    // the hub should still deliver agent.* terminal from buffer/grace.
    if (terminalStatuses.has(run.status) && !runManager.isLive(run.id)) {
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      if (cleaned || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(formatSseComment("heartbeat"));
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    request.raw.on("close", cleanup);
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

function mapExecutionError(reply: FastifyReply, error: unknown) {
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
    if (
      error.code === "AGENT_EXECUTION_FAILED" ||
      error.code === "AGENT_PERSISTENCE_FAILED"
    ) {
      return reply.status(500).send({
        error: {
          statusCode: 500,
          message: "Agent run failed",
          code: error.code,
        },
      });
    }
  }
  throw error;
}
