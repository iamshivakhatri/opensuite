import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import type { SessionAuth } from "./auth/session.js";
import type { AppConfig } from "./config/index.js";
import type { AuthHandler } from "./routes/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";

export interface AppDependencies {
  readonly auth: AuthHandler & SessionAuth;
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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    request.log.error({ err: error }, "request error");

    reply.status(statusCode).send({
      error: {
        statusCode,
        message: statusCode >= 500 ? "Internal Server Error" : error.message,
      },
    });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, deps.auth);
  registerMeRoutes(app, deps.auth);

  return app;
}
