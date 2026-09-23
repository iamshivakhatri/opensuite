/**
 * Production-safe migrator. Prints the underlying pg error (drizzle-kit
 * migrate swallows it). Prefer this from Docker entrypoint.
 *
 * Usage (from packages/db): node ./scripts/migrate.mjs
 * Requires DATABASE_URL in the environment or a root/packages `.env`
 * (same loader rules as packages/db/load-env.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../migrations");

/**
 * Load the first found `.env` without dotenv expansion/URL-decoding so
 * encoded DATABASE_URL passwords stay intact. Explicit shell env wins.
 */
function loadEnvFile() {
  const envCandidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(here, "../../../.env"),
  ];

  for (const envPath of envCandidates) {
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] ??= value;
    }

    return;
  }
}

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
  loadEnvFile();

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
