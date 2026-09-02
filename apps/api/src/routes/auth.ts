import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";

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
): void {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      try {
        const url = new URL(request.url, configBaseUrl(request));
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

        reply.status(response.status);
        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });

        const body = response.body ? await response.text() : null;
        return reply.send(body);
      } catch (error) {
        request.log.error({ err: error }, "authentication handler error");
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

function configBaseUrl(request: {
  headers: { host?: string };
}): string {
  const host = request.headers.host;
  if (!host) {
    throw new Error("Missing Host header");
  }
  return `http://${host}`;
}
