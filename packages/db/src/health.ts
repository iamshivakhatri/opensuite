import { sql } from "drizzle-orm";

import type { Db } from "./client.js";

/**
 * Verifies that the database is reachable by executing `SELECT 1`.
 * Throws if the connection fails or the query returns an unexpected result.
 */
export async function checkDatabaseConnection(db: Db): Promise<void> {
  const result = await db.execute(sql`SELECT 1 AS ok`);

  const row = result.rows[0] as { ok: number } | undefined;
  if (row?.ok !== 1) {
    throw new Error("Database connectivity check returned an unexpected result");
  }
}
