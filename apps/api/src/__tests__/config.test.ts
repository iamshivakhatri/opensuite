import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../config/index.js";

const baseEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/opensuite",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:3001",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "OpenSuite <noreply@example.com>",
};

test("loadConfig applies defaults when auth/database env vars are provided", () => {
  const config = loadConfig(baseEnv);

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.databaseUrl, baseEnv.DATABASE_URL);
  assert.equal(config.betterAuthSecret, baseEnv.BETTER_AUTH_SECRET);
  assert.equal(config.betterAuthUrl, baseEnv.BETTER_AUTH_URL);
  assert.equal(config.webOrigin, baseEnv.WEB_ORIGIN);
  assert.equal(config.resendApiKey, baseEnv.RESEND_API_KEY);
  assert.equal(config.emailFrom, baseEnv.EMAIL_FROM);
});

test("loadConfig parses provided env vars", () => {
  const config = loadConfig({
    ...baseEnv,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "4000",
    LOG_LEVEL: "warn",
    BETTER_AUTH_URL: "http://127.0.0.1:4000",
    WEB_ORIGIN: "https://app.example.com",
  });

  assert.equal(config.nodeEnv, "production");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4000);
  assert.equal(config.logLevel, "warn");
  assert.equal(config.betterAuthUrl, "http://127.0.0.1:4000");
  assert.equal(config.webOrigin, "https://app.example.com");
});

test("loadConfig throws a descriptive error for an invalid PORT", () => {
  assert.throws(() => loadConfig({ ...baseEnv, PORT: "not-a-number" }), /PORT/);
});

test("loadConfig throws when DATABASE_URL is missing", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("loadConfig throws when BETTER_AUTH_SECRET is too short", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, BETTER_AUTH_SECRET: "short" }),
    /BETTER_AUTH_SECRET/,
  );
});

test("loadConfig throws a descriptive error for an invalid NODE_ENV", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, NODE_ENV: "staging" }),
    /NODE_ENV/,
  );
});

test("loadConfig throws when RESEND_API_KEY is missing", () => {
  const { RESEND_API_KEY: _omit, ...rest } = baseEnv;
  assert.throws(() => loadConfig(rest), /RESEND_API_KEY/);
});

test("loadConfig throws when EMAIL_FROM does not contain an email address", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, EMAIL_FROM: "not-an-email" }),
    /EMAIL_FROM/,
  );
});
