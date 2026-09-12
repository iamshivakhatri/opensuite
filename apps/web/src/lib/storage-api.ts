/**
 * Authenticated storage + trash purge API helpers.
 */

export interface StorageStatus {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly remainingBytes: number;
}

export class StorageApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "StorageApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireApiBaseUrl(): string {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiBaseUrl) {
    throw new StorageApiError(
      500,
      "MISSING_API_URL",
      "OpenSuite API URL is not configured",
    );
  }
  return apiBaseUrl;
}

async function parseError(response: Response): Promise<StorageApiError> {
  try {
    const body = (await response.json()) as {
      error?: { statusCode?: number; code?: string; message?: string };
    };
    return new StorageApiError(
      body.error?.statusCode ?? response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "Something went wrong. Please try again.",
    );
  } catch {
    return new StorageApiError(
      response.status,
      "REQUEST_FAILED",
      "Something went wrong. Please try again.",
    );
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${requireApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
  });
}

export async function fetchStorageStatus(): Promise<StorageStatus> {
  const response = await apiFetch("/api/storage");
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as StorageStatus;
}

/**
 * Permanently delete a soft-deleted document owned by the current user.
 * Active documents are rejected by the backend — do not call from workspace views.
 */
export async function purgeTrashedDocument(documentId: string): Promise<void> {
  const response = await apiFetch(`/api/trash/documents/${documentId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await parseError(response);
}
