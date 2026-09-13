"use client";

import * as React from "react";
import Link from "next/link";

import { PageError, PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import { fetchStorageStatus } from "@/lib/storage-api";
import {
  STORAGE_CHANGED_EVENT,
  TRASH_PATH,
  storageQuotaKind,
  storageQuotaMessage,
  storageRemainingLabel,
  storageUsageRatio,
  storageUsedOfQuotaLabel,
  type StorageStatus,
} from "@/lib/storage-model";
import { cn } from "@/lib/utils";

export function StorageSettings() {
  const [status, setStatus] = React.useState<StorageStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchStorageStatus());
    } catch (err) {
      setStatus(null);
      setError(userFacingError(err, "Could not load storage."));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    function onChanged() {
      void load();
    }
    window.addEventListener(STORAGE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, onChanged);
  }, [load]);

  if (loading && status === null && !error) {
    return <PageLoading variant="settings" />;
  }

  if (error && status === null) {
    return <PageError message={error} onRetry={() => void load()} />;
  }

  if (!status) return null;

  const kind = storageQuotaKind(status);
  const ratio = storageUsageRatio(status);
  const message = storageQuotaMessage(kind);

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] leading-snug text-ink-soft">
        Storage includes all saved document versions, including items currently
        in Trash. Soft-deleted files still count toward your quota until they
        are permanently deleted.
      </p>

      <div
        className={cn(
          "rounded-[var(--radius-md)] border bg-surface px-4 py-4",
          kind === "full"
            ? "border-danger/25"
            : kind === "near"
              ? "border-accent-line"
              : "border-line",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px] font-medium text-ink">
            {storageUsedOfQuotaLabel(status)}
          </div>
          <div
            className={cn(
              "text-[12px] tabular-nums",
              kind === "full" ? "font-medium text-danger" : "text-ink-faint",
            )}
          >
            {storageRemainingLabel(status)}
          </div>
        </div>

        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label="Storage used"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              kind === "full" ? "bg-danger" : "bg-primary",
            )}
            style={{ width: `${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` }}
          />
        </div>

        {message ? (
          <p
            className={cn(
              "mt-3 text-[12px] leading-snug",
              kind === "full" ? "text-danger" : "text-ink-soft",
            )}
          >
            {message}
          </p>
        ) : null}
      </div>

      <div>
        <Link
          href={TRASH_PATH}
          className="text-[12.5px] font-medium text-accent-hover underline-offset-2 hover:underline"
        >
          Review Trash
        </Link>
        <p className="mt-1 text-[11.5px] text-ink-faint">
          Permanently delete trashed workspaces and documents to reclaim storage.
        </p>
      </div>

      {error ? (
        <PageError message={error} onRetry={() => void load()} />
      ) : null}
    </div>
  );
}
