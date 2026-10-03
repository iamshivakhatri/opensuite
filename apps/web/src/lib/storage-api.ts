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

/**
 * Permanently delete selected trashed workspaces and/or documents.
 */
export async function purgeTrashSelection(input: {
  readonly workspaceIds: readonly string[];
  readonly documentIds: readonly string[];
}): Promise<void> {
  const response = await apiFetch("/api/trash/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceIds: input.workspaceIds,
      documentIds: input.documentIds,
    }),
  });
  if (!response.ok) throw await parseApiError(response);
}

/** Permanently delete everything currently in the owner's trash. */
export async function emptyTrash(): Promise<void> {
  const response = await apiFetch("/api/trash", { method: "DELETE" });
  if (!response.ok) throw await parseApiError(response);
}
