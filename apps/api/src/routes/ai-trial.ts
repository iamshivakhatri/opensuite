import type { FastifyInstance } from "fastify";
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { ManagedTrialService } from "../managed-trial/service.js";

export function registerAiTrialRoutes(app: FastifyInstance, auth: SessionAuth, trial: ManagedTrialService): void {
  app.get("/api/ai-trial", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send({ error: { statusCode: 401, message: "Unauthorized", code: "UNAUTHENTICATED" } });
    return reply.send(await trial.status(user.id));
  });
}
