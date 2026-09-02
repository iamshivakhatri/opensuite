import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkDatabaseConnection,
  createDbClient,
  loadDatabaseConfig,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;

test(
  "checkDatabaseConnection succeeds when DATABASE_URL is configured",
  { skip: databaseUrl === undefined },
  async () => {
    const config = loadDatabaseConfig({ DATABASE_URL: databaseUrl });
    const client = createDbClient(config);

    try {
      await checkDatabaseConnection(client.db);
    } finally {
      await client.close();
    }

    assert.ok(true);
  },
);
