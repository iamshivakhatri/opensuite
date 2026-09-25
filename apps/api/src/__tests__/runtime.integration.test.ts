import "../load-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../config/index.js";
import { createOpenSuiteRuntime } from "../runtime.js";
import { testAgentEnv, testS3Env } from "./support/test-env.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

test(
  "a caller can add routes to one shared OpenSuite runtime",
  { skip: !runDbIntegrationTests || !databaseUrl },
  async () => {
    const runtime = await createOpenSuiteRuntime(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET ??
          "test-secret-that-is-at-least-32-characters-long",
        BETTER_AUTH_URL: "http://localhost:3000",
        WEB_ORIGIN: "http://localhost:3001",
        RESEND_API_KEY: "re_test_key_unused_by_this_test",
        EMAIL_FROM: "OpenSuite <noreply@example.com>",
        ...testAgentEnv,
        ...testS3Env,
      }),
    );

    try {
      runtime.app.register((app, _options, done) => {
        app.get("/api/cloud-composition-check", async () => ({ ok: true }));
        done();
      });

      const response = await runtime.app.inject({
        method: "GET",
        url: "/api/cloud-composition-check",
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true });
    } finally {
      await runtime.close();
    }
  },
);
