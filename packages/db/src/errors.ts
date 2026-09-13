/**
 * Detects Postgres / node-postgres connectivity failures (timeouts, refused,
 * DNS, terminated pool clients). Walks `cause` so Drizzle/Better Auth wrappers
 * still match.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };

    const code = typeof record.code === "string" ? record.code : "";
    const message =
      typeof record.message === "string" ? record.message.toLowerCase() : "";

    if (
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "57P01" ||
      code === "57P03" ||
      message.includes("connect etimedout") ||
      message.includes("connect econnrefused") ||
      message.includes("connection terminated") ||
      message.includes("timeout expired") ||
      message.includes("connection refused") ||
      message.includes("could not connect") ||
      message.includes("database connectivity check")
    ) {
      return true;
    }

    // AggregateError from some Node versions
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        if (isDatabaseUnavailableError(nested)) {
          return true;
        }
      }
    }

    current = record.cause;
  }

  return false;
}
