import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { DatabaseConfig } from "./config/index.js";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

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
 */
export function createDbClient(config: DatabaseConfig): DbClient {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
