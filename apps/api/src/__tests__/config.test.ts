import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../config/index.js";
import { testS3Env } from "./support/test-env.js";

const baseEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/opensuite",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:3001",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "OpenSuite <noreply@example.com>",
  ...testS3Env,
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
  assert.equal(config.s3.endpoint, testS3Env.S3_ENDPOINT);
  assert.equal(config.s3.bucket, testS3Env.S3_BUCKET);
  assert.equal(config.s3.forcePathStyle, true);
  assert.equal(config.uploadMaxBytes, 25 * 1024 * 1024);
  assert.equal(config.agent.provider, "unconfigured");
  assert.equal(config.agent.anthropicApiKey, null);
  assert.equal(config.agent.anthropicModel, "claude-sonnet-4-5");
});

test("loadConfig accepts legacy MINIO_* aliases for S3 settings", () => {
  const {
    S3_ENDPOINT: _e,
    S3_ACCESS_KEY_ID: _a,
    S3_SECRET_ACCESS_KEY: _s,
    S3_BUCKET: _b,
    S3_REGION: _r,
    S3_FORCE_PATH_STYLE: _f,
    ...withoutS3
  } = baseEnv;

  const config = loadConfig({
    ...withoutS3,
    MINIO_ENDPOINT: "http://minio.local:9000",
    MINIO_ACCESS_KEY: "minio-key",
    MINIO_SECRET_KEY: "minio-secret",
    MINIO_BUCKET: "opensuite",
  });

  assert.equal(config.s3.endpoint, "http://minio.local:9000");
  assert.equal(config.s3.accessKeyId, "minio-key");
  assert.equal(config.s3.secretAccessKey, "minio-secret");
  assert.equal(config.s3.bucket, "opensuite");
  assert.equal(config.s3.region, "us-east-1");
  assert.equal(config.s3.forcePathStyle, true);
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

test("loadConfig allows fake provider outside production", () => {
  const config = loadConfig({
    ...baseEnv,
    NODE_ENV: "development",
    AGENT_MODEL_PROVIDER: "fake",
  });
  assert.equal(config.agent.provider, "fake");
});

test("loadConfig rejects fake provider in production", () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        AGENT_MODEL_PROVIDER: "fake",
      }),
    /AGENT_MODEL_PROVIDER/,
  );
});

test("loadConfig requires ANTHROPIC_API_KEY for anthropic provider", () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        AGENT_MODEL_PROVIDER: "anthropic",
      }),
    /ANTHROPIC_API_KEY/,
  );
});

test("loadConfig accepts anthropic provider with key and model", () => {
  const config = loadConfig({
    ...baseEnv,
    AGENT_MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MODEL: "claude-test-model",
  });
  assert.equal(config.agent.provider, "anthropic");
  assert.equal(config.agent.anthropicApiKey, "sk-ant-test");
  assert.equal(config.agent.anthropicModel, "claude-test-model");
});

test("loadConfig rejects invalid AGENT_MODEL_PROVIDER", () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        AGENT_MODEL_PROVIDER: "openai",
      }),
    /AGENT_MODEL_PROVIDER/,
  );
});
