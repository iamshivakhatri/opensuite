import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";

import type { Db } from "@opensuite/db";

import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import { createDocumentService } from "./documents/service.js";
import type { AuthHandler } from "./routes/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { ObjectStorage } from "./storage/types.js";
import { createWorkspaceService } from "./workspaces/service.js";

export interface AppDependencies {
  readonly auth: AuthHandler & SessionAuth;
  readonly db: Db;
  readonly storage: ObjectStorage;
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
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, deps.auth);
  registerMeRoutes(app, deps.auth);
  registerWorkspaceRoutes(app, deps.auth, workspaces);
  registerDocumentRoutes(app, deps.auth, workspaces, documents);

  return app;
}
