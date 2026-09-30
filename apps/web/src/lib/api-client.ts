/**
 * Shared authenticated OpenSuite API transport.
 * Feature modules call this for HOW; they keep owning WHAT.
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Same strip rules as `api-base-url.ts` (kept local so Node strip-types tests
 * can load this module without extensionless relative imports).
 */
function resolveApiBaseUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_API_URL,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireApiBaseUrl(): string {
  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    throw new ApiError(
      500,
      "MISSING_API_URL",
      "OpenSuite API URL is not configured",
    );
  }
  return apiBaseUrl;
}

/** Parse a non-2xx OpenSuite JSON error body into ApiError. */
export async function parseApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: {
        statusCode?: number;
        code?: string;
        message?: string;
        activeRunId?: string;
        activeThreadId?: string;
      };
    };
    const error = body.error;
    const details: Record<string, unknown> = {};
    if (typeof error?.activeRunId === "string") {
      details.activeRunId = error.activeRunId;
    }
    if (typeof error?.activeThreadId === "string") {
      details.activeThreadId = error.activeThreadId;
    }
    if (error?.code === "DATABASE_UNAVAILABLE") {
      return new ApiError(
        error.statusCode ?? response.status,
        "DATABASE_UNAVAILABLE",
        "No connection with the database",
        Object.keys(details).length > 0 ? details : undefined,
      );
    }
    return new ApiError(
      error?.statusCode ?? response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "Something went wrong. Please try again.",
      Object.keys(details).length > 0 ? details : undefined,
    );
  } catch {
    return new ApiError(
      response.status,
      "REQUEST_FAILED",
      "Something went wrong. Please try again.",
    );
  }
}

/**
 * Authenticated fetch against the configured API origin.
 * Network failures become ApiError `API_UNREACHABLE` (including when the
 * browser throws on DNS/connection failure). Callers that pass AbortSignal
 * still see `signal.aborted` as true after the throw.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${requireApiBaseUrl()}${path}`;
  try {
    return await fetch(url, {
      ...init,
      credentials: "include",
    });
  } catch {
    throw new ApiError(
      503,
      "API_UNREACHABLE",
      "Can't reach the API. Try again in a moment.",
    );
  }
}
