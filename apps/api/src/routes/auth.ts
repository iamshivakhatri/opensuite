import type { Db } from "@opensuite/db";
import { probeDatabase } from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";

import {
  databaseUnavailableBody,
  shouldTreatAsDatabaseUnavailable,
} from "../database-availability.js";
import type { AppConfig } from "../config/index.js";

export interface AuthHandler {
  handler(request: Request): Promise<Response>;
}

/**
 * Mounts Better Auth's handler at `/api/auth/*` per the official Fastify
 * integration guide. Converts Fastify requests to Fetch API Request objects
 * and forwards Better Auth responses back to the client unchanged.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthHandler,
  deps: { readonly db: Db; readonly authUrl: AppConfig["betterAuthUrl"] },
): void {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      try {
        // The tunnel terminates HTTPS before Fastify. Use the validated public
        // URL instead of its internal HTTP connection when handing the request
        // to Better Auth, so callback cookies retain the public HTTPS context.
        const url = new URL(request.url, deps.authUrl);
        const headers = fromNodeHeaders(request.headers);

        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          body:
            request.body !== undefined && request.body !== null
              ? JSON.stringify(request.body)
              : undefined,
        });

        const response = await auth.handler(req);

        // Better Auth often returns 5xx JSON instead of throwing when Postgres
        // is down — rewrite to a stable DATABASE_UNAVAILABLE signal.
        if (response.status >= 500) {
          const database = await probeDatabase(deps.db);
          if (database === "unavailable") {
            return reply.status(503).send(databaseUnavailableBody);
          }
        }

        reply.status(response.status);
        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });

        const body = response.body ? await response.text() : null;
        return reply.send(body);
      } catch (error) {
        request.log.error({ err: error }, "authentication handler error");
        if (await shouldTreatAsDatabaseUnavailable(error, deps.db)) {
          return reply.status(503).send(databaseUnavailableBody);
        }
        return reply.status(500).send({
          error: {
            statusCode: 500,
            message: "Internal authentication error",
            code: "AUTH_FAILURE",
          },
        });
      }
    },
  });
}
