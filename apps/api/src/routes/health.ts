import type { FastifyInstance } from "fastify";

/**
 * Liveness/readiness endpoint. Deliberately has no dependencies (no DB,
 * storage, or engine checks) until those actually exist — a health check
 * that depends on unbuilt subsystems would just be wrong today.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({
    status: "ok" as const,
    uptimeSeconds: process.uptime(),
  }));
}
