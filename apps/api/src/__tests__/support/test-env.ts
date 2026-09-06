/** Shared dummy S3 env so `loadConfig` succeeds in tests that inject fake storage. */
export const testS3Env = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_BUCKET: "opensuite-test",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
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
