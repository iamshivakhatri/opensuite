/**
 * Pure helpers for Settings → Storage and trash purge UX.
 * Bytes from GET /api/storage are authoritative; formatting is display-only.
 */

export interface StorageStatus {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly remainingBytes: number;
}

/** UI-only threshold for restrained near-quota treatment. */
export const STORAGE_NEAR_QUOTA_RATIO = 0.9;

export type StorageQuotaKind = "normal" | "near" | "full";

/**
 * Binary units (1024), matching backend `USER_STORAGE_QUOTA_BYTES` (MiB).
 * Display-only — does not alter accounting.
 */
export function formatStorageBytes(sizeBytes: number): string {
  const bytes = Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
}

export function storageUsageRatio(status: StorageStatus): number {
  if (!Number.isFinite(status.quotaBytes) || status.quotaBytes <= 0) {
    return status.usedBytes > 0 ? 1 : 0;
  }
  return Math.min(1, Math.max(0, status.usedBytes / status.quotaBytes));
}

export function storageQuotaKind(status: StorageStatus): StorageQuotaKind {
  if (status.remainingBytes <= 0 || status.usedBytes >= status.quotaBytes) {
    return "full";
  }
  if (storageUsageRatio(status) >= STORAGE_NEAR_QUOTA_RATIO) {
    return "near";
  }
  return "normal";
}

export function storageUsedOfQuotaLabel(status: StorageStatus): string {
  return `${formatStorageBytes(status.usedBytes)} of ${formatStorageBytes(status.quotaBytes)} used`;
}

export function storageRemainingLabel(status: StorageStatus): string {
  if (storageQuotaKind(status) === "full") {
    return "0 B remaining";
  }
  return `${formatStorageBytes(status.remainingBytes)} remaining`;
}

export function storageQuotaMessage(kind: StorageQuotaKind): string | null {
  if (kind === "near") {
    return "Storage is almost full. Permanently delete items in Trash to free space.";
  }
  if (kind === "full") {
    return "Storage is full. New document versions cannot be saved until you free space in Trash.";
  }
  return null;
}

export const TRASH_PATH = "/app/trash";

export const STORAGE_CHANGED_EVENT = "opensuite:storage-changed";

export function notifyStorageChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT));
}

/** Product copy for irreversible document purge confirmation. */
export function permanentDeleteConfirmBody(documentName: string): string {
  return (
    `"${documentName}" will be permanently deleted. All saved versions will be ` +
    `removed and the storage they use will be reclaimed. This cannot be undone.`
  );
}

/**
 * Product copy for irreversible workspace purge confirmation.
 * Larger scope than a single document — UI should present this distinctly.
 */
export function permanentWorkspaceDeleteConfirmCopy(workspaceName: string): {
  readonly lead: string;
  readonly items: readonly string[];
  readonly footer: string;
} {
  return {
    lead: `Permanently deleting "${workspaceName}" will remove:`,
    items: [
      "the workspace",
      "all documents inside it",
      "all saved document versions",
      "workspace conversation history",
      "associated stored document data",
    ],
    footer:
      "Storage used by this workspace will be reclaimed. This cannot be undone.",
  };
}

/** Flat body string for tests / non-React consumers. */
export function permanentWorkspaceDeleteConfirmBody(
  workspaceName: string,
): string {
  const copy = permanentWorkspaceDeleteConfirmCopy(workspaceName);
  return `${copy.lead} ${copy.items.join("; ")}. ${copy.footer}`;
}

export type TrashPurgeKind = "document" | "workspace";

/** Permanent delete is only offered from Trash — never active library surfaces. */
export const PERMANENT_DELETE_SURFACE = "trash" as const;

export function trashPurgePath(kind: TrashPurgeKind, id: string): string {
  return kind === "document"
    ? `/api/trash/documents/${id}`
    : `/api/trash/workspaces/${id}`;
}

/** Success-path list update after a permanent purge (failure must not call this). */
export function removePurgedTrashItem<T extends { readonly id: string }>(
  items: readonly T[],
  purgedId: string,
): T[] {
  return items.filter((item) => item.id !== purgedId);
}

export function trashDocumentActions(options: {
  readonly workspaceDeleted: boolean;
}): {
  readonly canRestore: boolean;
  readonly canPermanentlyDelete: boolean;
  readonly restoreBlockedReason: string | null;
} {
  return {
    canRestore: !options.workspaceDeleted,
    canPermanentlyDelete: true,
    restoreBlockedReason: options.workspaceDeleted
      ? "Restore the workspace first"
      : null,
  };
}

/** Trashed workspaces: restore + permanent purge (owned trashed only; backend enforces). */
export function trashWorkspaceActions(): {
  readonly canRestore: boolean;
  readonly canPermanentlyDelete: boolean;
} {
  return {
    canRestore: true,
    canPermanentlyDelete: true,
  };
}
