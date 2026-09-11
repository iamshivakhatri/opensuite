import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import { providerCredentialProviders } from "../credentials/types.js";
import type { AiPreferenceService } from "../ai-preferences/service.js";
import { credentialSources } from "../ai-preferences/types.js";
import type { OpenRouterManagedModelCatalog } from "../openrouter-models/catalog.js";
import { OpenRouterCatalogError } from "../openrouter-models/types.js";

const bodySchema = z.object({
  provider: z.enum(providerCredentialProviders),
  model: z.string().trim().min(1, "Model is required"),
  credentialSource: z.enum(credentialSources),
});

const unauthenticated = {
  error: {
    statusCode: 401,
    message: "Unauthorized",
    code: "UNAUTHENTICATED",
  },
};

export function registerAiPreferenceRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  preferences: AiPreferenceService,
  catalog?: OpenRouterManagedModelCatalog | null,
): void {
  app.get("/api/ai-preferences", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated);
    return reply.send({ preference: await preferences.get(user.id) });
  });

  app.put("/api/ai-preferences", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send(unauthenticated);
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: issue?.message ?? "Invalid AI preference",
          code: "INVALID_AI_PREFERENCE",
        },
      });
    }

    const { provider, model, credentialSource } = parsed.data;

    if (credentialSource === "managed") {
      if (provider !== "openrouter") {
        return reply.status(400).send({
          error: {
            statusCode: 400,
            message:
              "Managed AI preferences must use provider openrouter with an OpenRouter model id",
            code: "INVALID_MANAGED_PREFERENCE",
          },
        });
      }
      if (!catalog) {
        return reply.status(503).send({
          error: {
            statusCode: 503,
            message: "Managed model catalog is not configured",
            code: "CATALOG_UNAVAILABLE",
          },
        });
      }
      try {
        await catalog.requireManagedModel(model);
      } catch (error) {
        if (error instanceof OpenRouterCatalogError) {
          const status = error.code === "MODEL_UNAVAILABLE" ? 400 : 502;
          return reply.status(status).send({
            error: {
              statusCode: status,
              message: error.message,
              code: error.code,
            },
          });
        }
        throw error;
      }
    }

    return reply.send({
      preference: await preferences.save({
        userId: user.id,
        provider,
        model,
        credentialSource,
      }),
    });
  });
}
