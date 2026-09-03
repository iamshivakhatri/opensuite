import "./load-env.js";

import {
  createDbClient,
  loadDatabaseConfig,
  type DbClient,
} from "@opensuite/db";

import { createAuth } from "./auth/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createResendEmailSender } from "./email/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
  const emailSender = createResendEmailSender({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
  });
  const auth = createAuth(config, dbClient.db, emailSender);
  const app = await buildApp(config, { auth, db: dbClient.db });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error, "failed to start server");
    await shutdown(dbClient, app, 1);
    return;
  }

  let shuttingDown = false;
  const shutdownHandler = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ signal }, "shutting down");
    await shutdown(dbClient, app, 0);
  };

  process.on("SIGTERM", () => void shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => void shutdownHandler("SIGINT"));
}

async function shutdown(
  dbClient: DbClient,
  app: Awaited<ReturnType<typeof buildApp>>,
  exitCode: number,
): Promise<void> {
  try {
    await app.close();
    await dbClient.close();
    process.exit(exitCode);
  } catch (error) {
    app.log.error(error, "error during shutdown");
    process.exit(1);
  }
}

void main();
