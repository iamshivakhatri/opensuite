import "./load-env.js";

import { loadConfig } from "./config/index.js";
import { createOpenSuiteRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createOpenSuiteRuntime(config);
  const { app } = runtime;

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error, "failed to start server");
    await shutdown(runtime, 1);
    return;
  }

  let shuttingDown = false;
  const shutdownHandler = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ signal }, "shutting down");
    await shutdown(runtime, 0);
  };

  process.on("SIGTERM", () => void shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => void shutdownHandler("SIGINT"));
}

async function shutdown(
  runtime: Awaited<ReturnType<typeof createOpenSuiteRuntime>>,
  exitCode: number,
): Promise<void> {
  try {
    await runtime.close();
    process.exit(exitCode);
  } catch (error) {
    runtime.app.log.error(error, "error during shutdown");
    process.exit(1);
  }
}

void main();
