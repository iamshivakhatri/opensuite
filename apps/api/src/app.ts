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
import { createAgentExecutionLeaseService } from "./agent/execution-lease.js";
import { createManagedTrialRepository } from "./managed-trial/repository.js";
import { createManagedTrialService } from "./managed-trial/service.js";
import { createStorageAccountingService } from "./storage-accounting/service.js";
import type { ConfirmationBridge } from "./agent/confirmation-bridge.js";
import {
  createConfiguredAgentModel,
  createResolvedAgentModel,
} from "./agent/model/index.js";
import { createAiModelResolver } from "./ai-preferences/resolver.js";
import { createAiPreferenceService } from "./ai-preferences/service.js";
import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import { createCredentialCipher } from "./credentials/crypto.js";
import { createProviderCredentialRepository } from "./credentials/repository.js";
import {
  createProviderCredentialService,
  type ProviderCredentialService,
} from "./credentials/service.js";
import { createDocumentService } from "./documents/service.js";
import {
  createDocumentRuntimeResolver,
  loadDocxEngineBinding,
} from "./documents/runtime.js";
import { createDocumentPreferenceService } from "./documents/preferences.js";
import { createSearchService } from "./documents/search.js";
import { createModelUsageRepository } from "./model-usage/repository.js";
import { createModelUsageService } from "./model-usage/service.js";
import type { AuthHandler } from "./routes/auth.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAiModelRoutes } from "./routes/ai-models.js";
import { registerAiTrialRoutes } from "./routes/ai-trial.js";
import { registerAiPreferenceRoutes } from "./routes/ai-preferences.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerProviderCredentialRoutes } from "./routes/provider-credentials.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { registerStorageRoutes } from "./routes/storage.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { createOpenRouterManagedModelCatalog } from "./openrouter-models/catalog.js";
import type { ObjectStorage } from "./storage/types.js";
import { createWorkspaceService } from "./workspaces/service.js";
import { isDevConsole, requestPath } from "./dev-log.js";

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
  /**
   * Interactive HTTP approve/deny bridge. When set (and `confirmation` is
   * not separately overridden), it becomes the execution service's
   * confirmation gate AND the resolver the confirm/deny route calls into.
   * Omitted → confirmation semantics are unchanged (deny-all by default).
   */
  readonly confirmationBridge?: ConfirmationBridge;
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
  /** Test/override: inject credential service without encryption-key config. */
  readonly credentials?: ProviderCredentialService;
  /** Test/override: inject managed model catalog (mocked OpenRouter). */
  readonly managedModelCatalog?: ReturnType<
    typeof createOpenRouterManagedModelCatalog
  >;
  /** Test/override: blank DOCX bytes without loading N-API. */
  readonly createBlankDocxBytes?: () => Uint8Array | Promise<Uint8Array>;
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
    const line = `${request.method} ${requestPath(request.url)} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`;
    if (isDevConsole()) {
      // Plain one-liner — no pino level/time/pid/hostname/reqId wrapper.
      console.log(line);
      console.log();
    } else {
      request.log.info(line);
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

  const credentials =
    deps.credentials ??
    (config.aiCredentialEncryptionKey
      ? createProviderCredentialService(
          createProviderCredentialRepository(deps.db),
          createCredentialCipher(config.aiCredentialEncryptionKey),
        )
      : null);
  const aiPreferences = createAiPreferenceService(deps.db);
  const modelUsage = createModelUsageService(
    createModelUsageRepository(deps.db),
  );
  const managedModelCatalog =
    deps.managedModelCatalog ??
    createOpenRouterManagedModelCatalog({
      apiKey: config.agent.openrouterApiKey,
    });
  const aiModelResolver =
    config.agent.provider === "anthropic" ||
    config.agent.provider === "openai" ||
    config.agent.provider === "openrouter" ||
    Boolean(config.agent.openrouterApiKey)
      ? createAiModelResolver({
          preferences: aiPreferences,
          credentials,
          managed: config.agent,
          catalog: managedModelCatalog,
        })
      : null;

  // Production: load N-API once for DOCX runtime + blank DOCX creation.
  // Tests may inject runtime and/or createBlankDocxBytes without the native binding.
  let resolveRuntime: import("./documents/runtime.js").DocumentRuntimeResolver | undefined;
  let documentRuntime = deps.agent?.runtime;
  let createBlankDocxBytes:
    | (() => Uint8Array | Promise<Uint8Array>)
    | undefined = deps.createBlankDocxBytes;
  let docxBinding: import("@opensuite/engine-client").DocxEngineBinding | undefined;

  if (!documentRuntime || !createBlankDocxBytes) {
    try {
      docxBinding = await loadDocxEngineBinding();
    } catch (error) {
      if (!documentRuntime) {
        throw error;
      }
      app.log.warn(
        { err: error },
        "DOCX engine binding unavailable; blank document creation disabled",
      );
    }
  }

  if (docxBinding && !createBlankDocxBytes) {
    const binding = docxBinding;
    createBlankDocxBytes = () => binding.createBlankDocx();
  }

  const storageAccounting = createStorageAccountingService(
    deps.db,
    config.userStorageQuotaBytes,
  );
  const workspaces = createWorkspaceService(
    deps.db,
    deps.storage,
    storageAccounting,
  );
  const documents = createDocumentService(deps.db, deps.storage, {
    uploadMaxBytes: config.uploadMaxBytes,
    storageAccounting,
    ...(createBlankDocxBytes ? { createBlankDocxBytes } : {}),
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
  const managedTrial = createManagedTrialService(
    createManagedTrialRepository(deps.db),
    config.managedAiTrialCreditMicros,
  );
  const search = createSearchService(deps.db);

  const agentPersistence =
    deps.agent?.persistence ?? createAgentPersistenceService(deps.db);
  const documentCapabilities =
    deps.agent?.capabilities ?? mutableDocumentCapabilities();
  // Prefer per-run capability discovery in AgentRunner when tools are not
  // explicitly injected (tests may still pass a fixed registry).
  const documentTools = deps.agent?.tools;

  if (!documentRuntime && docxBinding) {
    resolveRuntime = createDocumentRuntimeResolver({
      documents,
      binding: docxBinding,
    });
  }

  const agentExecution =
    deps.agent?.execution ??
    createAgentExecutionService({
      persistence: agentPersistence,
      documents,
      model: deps.agent?.model ?? createConfiguredAgentModel(config),
      ...(aiModelResolver && !deps.agent?.model
        ? {
            resolveModel: async (userId: string) => {
              const resolved = await aiModelResolver.resolve(userId);
              return {
                model: createResolvedAgentModel(resolved),
                usageAttribution: {
                  provider: resolved.provider,
                  model: resolved.model,
                  credentialSource: resolved.credentialSource,
                },
              };
            },
            modelUsage,
          }
        : {}),
      lease: createAgentExecutionLeaseService(deps.db),
      managedTrial,
      tools: documentTools,
      runtime: documentRuntime,
      resolveRuntime,
      confirmation: deps.agent?.confirmation ?? deps.agent?.confirmationBridge,
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
  registerAiModelRoutes(app, deps.auth, managedModelCatalog);
  registerAiTrialRoutes(app, deps.auth, managedTrial);
  registerAiPreferenceRoutes(app, deps.auth, aiPreferences, managedModelCatalog);
  registerWorkspaceRoutes(app, deps.auth, workspaces);
  registerProviderCredentialRoutes(app, deps.auth, credentials);
  registerDocumentRoutes(app, deps.auth, workspaces, documents, preferences);
  registerTrashRoutes(app, deps.auth, workspaces, documents);
  registerStorageRoutes(app, deps.auth, storageAccounting);
  registerSearchRoutes(app, deps.auth, search);
  registerAgentRoutes(app, {
    auth: deps.auth,
    documents,
    persistence: agentPersistence,
    execution: agentExecution,
    runManager: agentRunManager,
    confirmationBridge: deps.agent?.confirmationBridge,
    webOrigin: config.webOrigin,
  });

  return app;
}
