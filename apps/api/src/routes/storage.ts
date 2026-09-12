import type { FastifyInstance } from "fastify";
import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { StorageAccountingService } from "../storage-accounting/service.js";

export function registerStorageRoutes(app: FastifyInstance, auth: SessionAuth, storage: StorageAccountingService): void {
  app.get("/api/storage", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) return reply.status(401).send({ error: { statusCode: 401, message: "Unauthorized", code: "UNAUTHENTICATED" } });
    return reply.send(await storage.status(user.id));
  });
}
