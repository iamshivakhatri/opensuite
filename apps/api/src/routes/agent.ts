import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { AgentCoreError, type AgentModel } from "@opensuite/agent-core";

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
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import {
  DocumentAccessError,
  type DocumentService,
} from "../documents/service.js";

const DocumentIdParams = z.object({
  documentId: z.uuid("documentId must be a UUID"),
});

const ThreadIdParams = z.object({
  threadId: z.uuid("threadId must be a UUID"),
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
 * Abort when the client disconnects before the response finishes.
 * Reliable for real HTTP sockets; `app.inject()` may not emit the same close.
 */
export function createRequestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded && !controller.signal.aborted) {
      controller.abort();
    }
  };
  request.raw.on("close", onClose);
  reply.raw.on("close", onClose);
  return controller.signal;
}

/**
 * Placeholder model for production composition until a real provider is wired.
 * Routes never construct FakeAgentModel — tests inject deterministic models.
 */
export function createUnconfiguredAgentModel(): AgentModel {
  return {
    async complete() {
      throw new AgentCoreError(
        "MODEL_FAILURE",
        "Agent model provider is not configured",
        {
          diagnostic: {
            code: "MODEL_FAILURE",
            severity: "error",
            message: "Agent model provider is not configured",
          },
        },
      );
    },
  };
}

export interface AgentRouteDeps {
  readonly auth: SessionAuth;
  readonly documents: DocumentService;
  readonly persistence: AgentPersistenceService;
  readonly execution: AgentExecutionService;
}

/**
 * Document-scoped agent thread + synchronous run HTTP surface.
 * No SSE, no workspace-level threads, no run-list endpoints.
 */
export function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  const { auth, documents, persistence, execution } = deps;

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
      return reply.send({
        messages: messages.map(toAgentMessageDto),
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

    const signal = createRequestAbortSignal(request, reply);

    try {
      const result = await execution.execute({
        userId: user.id,
        threadId: params.data.threadId,
        instruction: body.data.instruction,
        signal,
      });

      if (reply.sent || reply.raw.writableEnded) {
        return;
      }

      if (result.run.status === "failed") {
        return reply.status(500).send({
          error: {
            statusCode: 500,
            message: "Agent run failed",
            code: "AGENT_EXECUTION_FAILED",
          },
          run: toAgentRunDto(result.run),
        });
      }

      return reply.status(200).send({
        run: toAgentRunDto(result.run),
        userMessage: toAgentMessageDto(result.userMessage),
        assistantMessage: result.assistantMessage
          ? toAgentMessageDto(result.assistantMessage)
          : null,
        steps: result.steps.map(toAgentStepDto),
      });
    } catch (error) {
      if (reply.sent || reply.raw.writableEnded) {
        return;
      }
      return mapExecutionError(reply, error);
    }
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
