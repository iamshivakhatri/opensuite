import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";

import {
  mutableDocumentCapabilities,
  type AgentModel,
  type ConfirmationGate,
  type DocumentRuntime,
  type RuntimeCapabilities,
  type SteeringSource,
  type ToolRegistry,
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
import {
  createAgentRunManager,
  type AgentRunManager,
} from "./agent/run-manager.js";
import {
  createConfiguredAgentModel,
} from "./agent/model/index.js";
import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import { createDocumentService } from "./documents/service.js";
import {
  createDocumentRuntimeResolver,
  loadDocxEngineBinding,
} from "./documents/runtime.js";
import { createDocumentPreferenceService } from "./documents/preferences.js";
import { createSearchService } from "./documents/search.js";
import type { AuthHandler } from "./routes/auth.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { ObjectStorage } from "./storage/types.js";
import { createWorkspaceService } from "./workspaces/service.js";

/**
 * Optional agent stack overrides for tests / future provider wiring.
 * Routes never construct FakeAgentModel — inject model/tools (or a full
 * execution service) from composition. Production model comes from
 * createConfiguredAgentModel(config) unless overridden here.
 */
export interface AgentAppDependencies {
  readonly persistence?: AgentPersistenceService;
  readonly execution?: AgentExecutionService;
  readonly runManager?: AgentRunManager;
  readonly model?: AgentModel;
  readonly tools?: ToolRegistry;
  readonly runtime?: DocumentRuntime;
  readonly confirmation?: ConfirmationGate;
  readonly steering?: SteeringSource;
  readonly capabilities?: RuntimeCapabilities;
  readonly maxTurns?: number;
  /** Shorter grace for SSE tests. */
  readonly liveGraceMs?: number;
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
    // Default Fastify request logs dump full req objects — unreadable in local
    // agent/chat loops. Use a one-line completion log instead.
    disableRequestLogging: true,
  });

  app.addHook("onResponse", (request, reply, done) => {
    // Skip CORS preflight + health noise.
    if (request.method === "OPTIONS" || request.url.startsWith("/health")) {
      done();
      return;
    }
    request.log.info(
      `${request.method} ${request.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`,
    );
    // Blank line between request logs — much easier to scan in a local terminal.
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    done();
  });

  await app.register(cors, {
    origin: config.webOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  const preferences = createDocumentPreferenceService(deps.db);
  const search = createSearchService(deps.db);

  const agentPersistence =
    deps.agent?.persistence ?? createAgentPersistenceService(deps.db);
  const documentCapabilities =
    deps.agent?.capabilities ?? mutableDocumentCapabilities();
  // Prefer per-run format-filtered registry in AgentExecutionService when
  // tools are not explicitly injected (tests may still pass a fixed registry).
  const documentTools = deps.agent?.tools;

  // Production: DOCX → real Rust engine; PPTX/XLSX stay on mock until wired.
  // Tests may still inject a fixed `runtime` (skips engine binding load).
  let resolveRuntime: import("./documents/runtime.js").DocumentRuntimeResolver | undefined;
  let documentRuntime = deps.agent?.runtime;
  if (!documentRuntime) {
    const binding = await loadDocxEngineBinding();
    resolveRuntime = createDocumentRuntimeResolver({
      documents,
      binding,
      mockCapabilities: documentCapabilities,
    });
  }

  const agentExecution =
    deps.agent?.execution ??
    createAgentExecutionService({
      persistence: agentPersistence,
      documents,
      model: deps.agent?.model ?? createConfiguredAgentModel(config),
      tools: documentTools,
      runtime: documentRuntime,
      resolveRuntime,
      confirmation: deps.agent?.confirmation,
      steering: deps.agent?.steering,
      capabilities: documentCapabilities,
      maxTurns: deps.agent?.maxTurns,
    });
  const agentRunManager =
    deps.agent?.runManager ??
    createAgentRunManager({
      execution: agentExecution,
      persistence: agentPersistence,
      liveGraceMs: deps.agent?.liveGraceMs,
    });

  registerHealthRoutes(app);
  registerAuthRoutes(app, deps.auth);
  registerMeRoutes(app, deps.auth);
  registerWorkspaceRoutes(app, deps.auth, workspaces);
  registerDocumentRoutes(app, deps.auth, workspaces, documents, preferences);
  registerTrashRoutes(app, deps.auth, workspaces, documents);
  registerSearchRoutes(app, deps.auth, search);
  registerAgentRoutes(app, {
    auth: deps.auth,
    documents,
    persistence: agentPersistence,
    execution: agentExecution,
    runManager: agentRunManager,
    webOrigin: config.webOrigin,
  });

  return app;
}
