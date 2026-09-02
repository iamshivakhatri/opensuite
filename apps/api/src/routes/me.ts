import type { FastifyInstance } from "fastify";

import { getRequestUser, type SessionAuth } from "../auth/session.js";

/**
 * First OpenSuite-owned protected route. Proves Better Auth sessions work
 * end-to-end through Fastify before anything else depends on it.
 */
export function registerMeRoutes(app: FastifyInstance, auth: SessionAuth): void {
  app.get("/api/me", async (request, reply) => {
    const user = await getRequestUser(auth, request);

    if (!user) {
      return reply.status(401).send({
        error: {
          statusCode: 401,
          message: "Unauthorized",
          code: "UNAUTHENTICATED",
        },
      });
    }

    return reply.send({ user });
  });
}
