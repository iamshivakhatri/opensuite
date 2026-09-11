import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import { providerCredentialProviders } from "../credentials/types.js";
import type { AiPreferenceService } from "../ai-preferences/service.js";
import { credentialSources } from "../ai-preferences/types.js";

const bodySchema = z.object({
  provider: z.enum(providerCredentialProviders),
  model: z.string().trim().min(1, "Model is required"),
  credentialSource: z.enum(credentialSources),
});

const unauthenticated = { error: { statusCode: 401, message: "Unauthorized", code: "UNAUTHENTICATED" } };

export function registerAiPreferenceRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  preferences: AiPreferenceService,
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
    return reply.send({ preference: await preferences.save({ userId: user.id, ...parsed.data }) });
  });
}
