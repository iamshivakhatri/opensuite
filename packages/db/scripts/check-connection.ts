import "../load-env.ts";

import {
  checkDatabaseConnection,
  createDbClient,
  loadDatabaseConfig,
} from "../src/index.js";

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const client = createDbClient(config);

  try {
    await checkDatabaseConnection(client.db);
    console.log("Database connection OK");
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Database connection failed: ${message}`);
  process.exit(1);
});
