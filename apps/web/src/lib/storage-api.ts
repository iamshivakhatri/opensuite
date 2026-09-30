/**
 * Authenticated storage + trash purge API helpers.
 */

import { apiFetch, parseApiError } from "./api-client";

export { ApiError } from "./api-client";

export interface StorageStatus {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly remainingBytes: number;
}

export async function fetchStorageStatus(): Promise<StorageStatus> {
  const response = await apiFetch("/api/storage");
  if (!response.ok) throw await parseApiError(response);
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
  if (!response.ok) throw await parseApiError(response);
}

/**
 * Permanently delete a soft-deleted workspace owned by the current user.
 * Only owned, already-trashed workspaces are accepted — do not call outside Trash.
 */
export async function purgeTrashedWorkspace(workspaceId: string): Promise<void> {
  const response = await apiFetch(`/api/trash/workspaces/${workspaceId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await parseApiError(response);
}
