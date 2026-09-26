import type { FastifyInstance } from "fastify";

import {
  createDbClient,
  type Db,
} from "@opensuite/db";

import { buildApp } from "./app.js";
import { createAgentExecutionLeaseService } from "./agent/execution-lease.js";
import { createAuth, type Auth } from "./auth/index.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import { createResendEmailSender } from "./email/index.js";
import { createS3ObjectStorage } from "./storage/index.js";
import type { AgentRunReportSink } from "./agent/agent-run-report.js";

/** The shared OpenSuite API process, before a caller starts listening. */
export interface OpenSuiteRuntime {
  readonly app: FastifyInstance;
  readonly auth: Auth;
  readonly db: Db;
  close(): Promise<void>;
}

export interface OpenSuiteRuntimeOptions {
  readonly agentRunReportSink?: AgentRunReportSink;
}

/**
 * Creates one complete OpenSuite API runtime. Callers may register additional
 * routes on `app` before listening; auth and DB stay shared with core routes.
 */
export async function createOpenSuiteRuntime(
  config: AppConfig = loadConfig(),
  options: OpenSuiteRuntimeOptions = {},
): Promise<OpenSuiteRuntime> {
  console.info("[agent] runtime=v3");
  const dbClient = createDbClient(
    { databaseUrl: config.databaseUrl },
    {
      onPoolError: (error) => {
        // Idle client errors must be handled; log and let later checkouts retry.
        console.error("[db] idle pool client error", error.message);
      },
    },
  );

  // Live runs are in-process only; a prior crash/force-kill leaves durable leases
  // that would falsely block new runs until expiry. Do not crash boot if Postgres
  // is briefly unreachable — /health will report degraded and routes return 503.
  try {
    const cleared = await createAgentExecutionLeaseService(dbClient.db).clearAll();
    if (cleared > 0) {
      console.info(`[agent] cleared ${cleared} orphaned execution lease(s) on boot`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[agent] skipped lease clear on boot (database unreachable): ${message}`);
  }

  const emailSender = createResendEmailSender({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
  });
  const auth = createAuth(config, dbClient.db, emailSender);
  const app = await buildApp(config, {
    auth,
    db: dbClient.db,
    storage: createS3ObjectStorage(config.s3),
    ...(options.agentRunReportSink
      ? { agent: { agentRunReportSink: options.agentRunReportSink } }
      : {}),
  });

  return {
    app,
    auth,
    db: dbClient.db,
    async close() {
      await app.close();
      await dbClient.close();
    },
  };
}
