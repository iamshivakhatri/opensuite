/**
 * Production-safe migrator. Prints the underlying pg error (drizzle-kit
 * migrate swallows it). Prefer this from Docker entrypoint.
 *
 * Usage (from packages/db): node ./scripts/migrate.mjs
 * Requires DATABASE_URL in the environment.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../migrations");

function redactDatabaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const cause = /** @type {{ cause?: unknown }} */ (error).cause;
  if (cause instanceof Error) {
    parts.push(`cause: ${cause.message}`);
    const code = /** @type {{ code?: string }} */ (cause).code;
    if (code) parts.push(`code: ${code}`);
  }
  return parts.join(" | ");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!existsSync(migrationsFolder)) {
    throw new Error(`migrations folder missing: ${migrationsFolder}`);
  }

  console.log(`[opensuite] migrate target: ${redactDatabaseUrl(databaseUrl)}`);
  console.log(`[opensuite] migrations folder: ${migrationsFolder}`);

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  try {
    await migrate(db, {
      migrationsFolder,
      migrationsSchema: "public",
    });
    console.log("[opensuite] migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[opensuite] migrate failed: ${formatError(error)}`);
  process.exit(1);
});
