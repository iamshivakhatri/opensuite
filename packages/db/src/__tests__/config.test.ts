import assert from "node:assert/strict";
import { test } from "node:test";

import { loadDatabaseConfig } from "../config/index.js";

test("loadDatabaseConfig parses a valid postgresql:// URL", () => {
  const config = loadDatabaseConfig({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/opensuite",
  });

  assert.equal(
    config.databaseUrl,
    "postgresql://user:pass@localhost:5432/opensuite",
  );
});

test("loadDatabaseConfig accepts postgres:// URL scheme", () => {
  const config = loadDatabaseConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/opensuite",
  });

  assert.equal(
    config.databaseUrl,
    "postgres://user:pass@localhost:5432/opensuite",
  );
});

test("loadDatabaseConfig throws when DATABASE_URL is missing", () => {
  assert.throws(() => loadDatabaseConfig({}), /DATABASE_URL/);
});

test("loadDatabaseConfig throws when DATABASE_URL is empty", () => {
  assert.throws(() => loadDatabaseConfig({ DATABASE_URL: "" }), /DATABASE_URL/);
});

test("loadDatabaseConfig throws for a non-PostgreSQL URL", () => {
  assert.throws(
    () => loadDatabaseConfig({ DATABASE_URL: "mysql://localhost/test" }),
    /PostgreSQL/,
  );
});
