import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";

import {
  ToolRegistry,
  type AgentModel,
  type ConfirmationGate,
  type DocumentRuntime,
  type RuntimeCapabilities,
  type SteeringSource,
} from "@opensuite/agent-core";
import type { Db } from "@opensuite/db";

import {
  createAgentExecutionService,
  type AgentExecutionService,
} from "./agent/execution.js";
import {
  createAgentPersistenceService,
  type AgentPersistenceService,
} from "./agent/persistence.js";
import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import { createDocumentService } from "./documents/service.js";
import type { AuthHandler } from "./routes/auth.js";
import {
  createUnconfiguredAgentModel,
  registerAgentRoutes,
} from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { ObjectStorage } from "./storage/types.js";
import { createWorkspaceService } from "./workspaces/service.js";

/**
 * Optional agent stack overrides for tests / future provider wiring.
 * Routes never construct FakeAgentModel — inject model/tools (or a full
 * execution service) from composition.
 */
export interface AgentAppDependencies {
  readonly persistence?: AgentPersistenceService;
  readonly execution?: AgentExecutionService;
  readonly model?: AgentModel;
  readonly tools?: ToolRegistry;
  readonly runtime?: DocumentRuntime;
  readonly confirmation?: ConfirmationGate;
  readonly steering?: SteeringSource;
  readonly capabilities?: RuntimeCapabilities;
  readonly maxTurns?: number;
}

export interface AppDependencies {
  readonly auth: AuthHandler & SessionAuth;
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly agent?: AgentAppDependencies;
}

/**
 * Builds a fully configured Fastify instance without starting to listen.
 */
export async function buildApp(
  config: AppConfig,
  deps: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  await app.register(cors, {
    origin: config.webOrigin,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
    maxAge: 86_400,
  });

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.uploadMaxBytes,
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    request.log.error({ err: error }, "request error");

    if (statusCode === 413) {
      return reply.status(413).send({
        error: {
          statusCode: 413,
          message: "Uploaded file is too large",
          code: "UPLOAD_TOO_LARGE",
        },
      });
    }

    reply.status(statusCode).send({
      error: {
        statusCode,
        message: statusCode >= 500 ? "Internal Server Error" : error.message,
      },
    });
  });

  const workspaces = createWorkspaceService(deps.db);
  const documents = createDocumentService(deps.db, deps.storage, {
    uploadMaxBytes: config.uploadMaxBytes,
    onCleanupFailure: (cleanupError, storageKey) => {
      app.log.error(
        { err: cleanupError, storageKey },
        "failed to delete object after document DB write failure",
      );
    },
    onMissingStorageObject: ({ documentId, versionId, storageKey, error }) => {
      app.log.error(
        { err: error, documentId, versionId, storageKey },
        "document version storage object missing",
      );
    },
  });

  const agentPersistence =
    deps.agent?.persistence ?? createAgentPersistenceService(deps.db);
  const agentExecution =
    deps.agent?.execution ??
    createAgentExecutionService({
      persistence: agentPersistence,
      documents,
      model: deps.agent?.model ?? createUnconfiguredAgentModel(),
      tools: deps.agent?.tools ?? ToolRegistry.create([]),
      runtime: deps.agent?.runtime,
      confirmation: deps.agent?.confirmation,
      steering: deps.agent?.steering,
      capabilities: deps.agent?.capabilities,
      maxTurns: deps.agent?.maxTurns,
    });

  registerHealthRoutes(app);
  registerAuthRoutes(app, deps.auth);
  registerMeRoutes(app, deps.auth);
  registerWorkspaceRoutes(app, deps.auth, workspaces);
  registerDocumentRoutes(app, deps.auth, workspaces, documents);
  registerAgentRoutes(app, {
    auth: deps.auth,
    documents,
    persistence: agentPersistence,
    execution: agentExecution,
  });

  return app;
}
