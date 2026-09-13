import type { FastifyInstance } from "fastify";
import { probeDatabase, type Db } from "@opensuite/db";

/**
 * Process liveness + database reachability.
 * Always returns HTTP 200 while the API process is up so orchestrators do not
 * kill the process during a Postgres outage. Clients read `database` /
 * top-level `status` (`ok` | `degraded`) to show recovery UI.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { readonly db: Db },
): void {
  app.get("/health", async () => {
    const database = await probeDatabase(deps.db);
    return {
      status: database === "ok" ? ("ok" as const) : ("degraded" as const),
      uptimeSeconds: process.uptime(),
      database,
    };
  });
}
