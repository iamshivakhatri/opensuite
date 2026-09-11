import type { FastifyInstance } from "fastify";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { OpenRouterManagedModelCatalog } from "../openrouter-models/catalog.js";
import { OpenRouterCatalogError } from "../openrouter-models/types.js";

const unauthenticated = {
  error: {
    statusCode: 401,
    message: "Unauthorized",
    code: "UNAUTHENTICATED",
  },
};

/**
 * Authenticated managed-model catalog for future Settings / model picker.
 * Never returns credentials or secrets.
 */
export function registerAiModelRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  catalog: OpenRouterManagedModelCatalog,
): void {
  app.get("/api/ai-models/managed", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated);
    }

    try {
      const models = await catalog.listManagedModels();
      return reply.send({ models });
    } catch (error) {
      if (error instanceof OpenRouterCatalogError) {
        return reply.status(502).send({
          error: {
            statusCode: 502,
            message: error.message,
            code: error.code,
          },
        });
      }
      throw error;
    }
  });
}
