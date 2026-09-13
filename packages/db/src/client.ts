import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { DatabaseConfig } from "./config/index.js";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

/** Fail checkout quickly when Postgres is unreachable (default pg waits ~75s). */
export const DATABASE_CONNECTION_TIMEOUT_MS = 5_000;

export interface CreateDbClientOptions {
  /** Called for idle-client pool errors (must be handled or Node can crash). */
  readonly onPoolError?: (error: Error) => void;
}

export interface DbClient {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Creates a typed Drizzle client backed by a node-postgres connection pool.
 *
 * Callers receive both the Drizzle `db` instance (for typed queries and
 * `db.execute(sql`...`)` raw SQL) and the underlying `pool` (for advanced
 * use). Always call `close()` when shutting down to release connections.
 *
 * The pool reconnects on the next checkout after transient outages — no
 * manual reconnect loop is required.
 */
export function createDbClient(
  config: DatabaseConfig,
  options: CreateDbClientOptions = {},
): DbClient {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  });
  pool.on("error", (error) => {
    options.onPoolError?.(error);
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
