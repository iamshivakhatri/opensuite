import "./load-env.ts";

import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration for schema introspection and migrations.
 * Requires DATABASE_URL to be set in the environment when running
 * generate/migrate/push commands.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Drizzle Kit defaults to creating a dedicated "drizzle" schema for its
  // internal migration-tracking table. Our DB role is only granted CREATE
  // on the "public" schema (see docs/status.md), so store the tracking
  // table there instead of requiring an extra schema-creation grant.
  migrations: {
    schema: "public",
  },
});
