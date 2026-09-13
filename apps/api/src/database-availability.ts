import {
  isDatabaseUnavailableError,
  probeDatabase,
  type Db,
} from "@opensuite/db";

export const DATABASE_UNAVAILABLE_CODE = "DATABASE_UNAVAILABLE" as const;

export const databaseUnavailableBody = {
  error: {
    statusCode: 503 as const,
    message: "Database temporarily unavailable",
    code: DATABASE_UNAVAILABLE_CODE,
  },
};

/** Better Auth often wraps PG failures as FAILED_TO_GET_SESSION without a cause. */
export function isFailedToGetSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as {
    message?: unknown;
    code?: unknown;
    body?: { code?: unknown; message?: unknown };
  };
  const code =
    (typeof record.code === "string" ? record.code : null) ??
    (typeof record.body?.code === "string" ? record.body.code : null);
  const message =
    (typeof record.message === "string" ? record.message : null) ??
    (typeof record.body?.message === "string" ? record.body.message : null);

  return (
    code === "FAILED_TO_GET_SESSION" ||
    message === "Failed to get session"
  );
}

/**
 * True when the error is (or is likely caused by) Postgres being unreachable.
 * For opaque Better Auth session failures, confirms with a live probe.
 */
export async function shouldTreatAsDatabaseUnavailable(
  error: unknown,
  db: Db,
): Promise<boolean> {
  if (isDatabaseUnavailableError(error)) {
    return true;
  }
  if (!isFailedToGetSessionError(error)) {
    return false;
  }
  return (await probeDatabase(db)) === "unavailable";
}
