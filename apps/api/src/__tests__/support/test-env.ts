/** Shared dummy S3 env so `loadConfig` succeeds in tests that inject fake storage. */
export const testS3Env = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_BUCKET: "opensuite-test",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
} as const;

/**
 * Lets API integration tests build the full route tree without contacting a
 * model provider. Tests that exercise agent execution inject their own model.
 */
export const testAgentEnv = {
  AGENT_MODEL_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "test-openrouter-key-not-used-for-network-calls",
  OPENROUTER_MODEL: "openrouter/test-model",
} as const;

export function multipartFilePayload(
  filename: string,
  content: Buffer | string,
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = "----opensuite-test-boundary";
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}

/** Multipart save: baseVersionId field + Office file body. */
export function multipartVersionSavePayload(
  filename: string,
  content: Buffer | string,
  baseVersionId: string,
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = "----opensuite-test-boundary";
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="baseVersionId"\r\n\r\n` +
        `${baseVersionId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}
