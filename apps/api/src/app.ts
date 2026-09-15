import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";

import type { Db } from "@opensuite/db";
import { createOpenRouterModel } from "@opensuite/agent-core-v2";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";

import {
  databaseUnavailableBody,
  shouldTreatAsDatabaseUnavailable,
} from "./database-availability.js";
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
import { createAiModelResolver } from "./ai-preferences/resolver.js";
import { createAiPreferenceService } from "./ai-preferences/service.js";
import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import {
  createProviderCredentialProbe,
  type ProviderCredentialProbe,
} from "./credentials/provider-probe.js";
import { createCredentialCipher } from "./credentials/crypto.js";
import { createProviderCredentialRepository } from "./credentials/repository.js";
import {
  createProviderCredentialService,
  type ProviderCredentialService,
} from "./credentials/service.js";
import { createDocumentService } from "./documents/service.js";
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
 * Optional product-shell overrides for tests.
 */
export interface AgentAppDependencies {
  readonly persistence?: AgentPersistenceService;
  readonly execution?: AgentExecutionService;
  readonly runManager?: AgentRunManager;
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
  /** Test/override: skip real provider HTTP for BYOK key/model checks. */
  readonly providerProbe?: ProviderCredentialProbe;
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

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
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

    if (await shouldTreatAsDatabaseUnavailable(error, deps.db)) {
      return reply.status(503).send(databaseUnavailableBody);
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
  const providerProbe =
    deps.providerProbe ?? createProviderCredentialProbe();
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
    Boolean(config.agent.openrouterApiKey) || Boolean(credentials)
      ? createAiModelResolver({
          preferences: aiPreferences,
          credentials,
          managed: config.agent,
          catalog: managedModelCatalog,
        })
      : null;

  // Production: load N-API once for blank DOCX creation.
  let createBlankDocxBytes:
    | (() => Uint8Array | Promise<Uint8Array>)
    | undefined = deps.createBlankDocxBytes;
  let docxBinding: import("@opensuite/engine-client").DocxEngineBinding | undefined;

  if (!createBlankDocxBytes) {
    try {
      docxBinding = await createNapiDocxEngineBinding();
    } catch (error) {
      // Soft-boot: API stays up for auth/workspaces/etc. DOCX mutate/blank
      // stay unavailable until @opensuite/engine (native) is installed.
      app.log.error(
        { err: error },
        "DOCX engine binding unavailable; blank document creation is unavailable",
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
    config.managedAiTrialDisplayCredits,
  );
  const search = createSearchService(deps.db);

  const agentPersistence =
    deps.agent?.persistence ?? createAgentPersistenceService(deps.db);
  const agentExecutionLease = createAgentExecutionLeaseService(deps.db);
  if (!aiModelResolver && !deps.agent?.execution) {
    throw new Error("OpenRouter configuration is required for Agent Core V2");
  }
  const agentExecution =
    deps.agent?.execution ??
    createAgentExecutionService({
      persistence: agentPersistence,
      documents,
      ...(docxBinding ? { docxBinding } : {}),
      resolveModel: async (userId: string) => {
        const resolved = await aiModelResolver!.resolve(userId);
        if (resolved.provider !== "openrouter") {
          throw new Error("Agent Core V2 currently requires OpenRouter");
        }
        return {
          model: createOpenRouterModel(resolved),
          usageAttribution: {
            provider: resolved.provider,
            model: resolved.model,
            credentialSource: resolved.credentialSource,
          },
        };
      },
      modelUsage,
      lease: agentExecutionLease,
      managedTrial,
    });
  const agentRunManager =
    deps.agent?.runManager ??
    createAgentRunManager({
      execution: agentExecution,
      persistence: agentPersistence,
      liveGraceMs: deps.agent?.liveGraceMs,
    });

  registerHealthRoutes(app, { db: deps.db });
  registerAuthRoutes(app, deps.auth, { db: deps.db });
  registerMeRoutes(app, deps.auth);
  registerAiModelRoutes(app, deps.auth, managedModelCatalog);
  registerAiTrialRoutes(app, deps.auth, managedTrial);
  registerAiPreferenceRoutes(app, deps.auth, aiPreferences, managedModelCatalog, {
    managedModel: config.agent.openrouterModel,
    credentials,
    probe: providerProbe,
  });
  registerWorkspaceRoutes(app, deps.auth, workspaces);
  registerProviderCredentialRoutes(
    app,
    deps.auth,
    credentials,
    providerProbe,
  );
  registerDocumentRoutes(app, deps.auth, workspaces, documents, preferences);
  registerTrashRoutes(app, deps.auth, workspaces, documents);
  registerStorageRoutes(app, deps.auth, storageAccounting);
  registerSearchRoutes(app, deps.auth, search);
  registerAgentRoutes(app, {
    auth: deps.auth,
    persistence: agentPersistence,
    runManager: agentRunManager,
    lease: agentExecutionLease,
    webOrigin: config.webOrigin,
  });

  return app;
}
