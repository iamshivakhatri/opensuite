"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatBytes, formatLabel } from "@/components/files/format";
import type { ListedDocument } from "@/lib/api";
import { workspacePath } from "@/lib/paths";

/**
 * Compact header — Workspaces › Workspace › Document.
 */
export function DocumentHeader({
  workspaceId,
  workspaceName,
  document,
  downloading,
  onDownload,
  starred,
  onToggleStar,
  onRename,
  onTrash,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
  downloading?: boolean;
  onDownload?: () => void;
  starred?: boolean;
  onToggleStar?: () => void;
  onRename?: () => void;
  onTrash?: () => void;
}) {
  const wsLabel = workspaceName?.trim() || "Workspace";

  return (
    <header
      className="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line px-3.5"
      style={{
        background: "color-mix(in srgb, var(--surface) 88%, transparent)",
        backdropFilter: "blur(16px) saturate(1.12)",
      }}
    >
      <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px]">
        <Link
          href="/app"
          className="shrink-0 font-medium text-ink-faint hover:text-ink"
        >
          Workspaces
        </Link>
        <span className="shrink-0 text-ink-faint/70">/</span>
        <Link
          href={workspacePath(workspaceId)}
          className={
            "min-w-0 truncate font-medium " +
            (document
              ? "text-ink-faint hover:text-ink"
              : "font-semibold text-ink")
          }
          title={wsLabel}
        >
          {wsLabel}
        </Link>
        {document ? (
          <>
            <span className="shrink-0 text-ink-faint/70">/</span>
            <button
              type="button"
              title="Rename"
              onClick={onRename}
              className="min-w-0 truncate text-left font-semibold text-ink hover:underline"
            >
              {document.name}
            </button>
            <span className="shrink-0 rounded-full border border-line bg-surface px-[6px] py-[1px] font-mono text-[7.5px] font-medium text-ink-faint">
              {formatLabel(document.format)}
            </span>
            <span className="hidden min-w-0 truncate text-[10px] text-ink-faint sm:inline">
              v{document.latestVersion.versionNumber} ·{" "}
              {formatBytes(document.latestVersion.sizeBytes)}
            </span>
          </>
        ) : null}
      </nav>

      {document ? (
        <div className="flex shrink-0 items-center gap-1">
          {onToggleStar ? (
            <button
              type="button"
              title={starred ? "Unstar" : "Star"}
              onClick={onToggleStar}
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[13px] text-ink-faint hover:bg-sunken hover:text-accent"
            >
              {starred ? "★" : "☆"}
            </button>
          ) : null}
          {onTrash ? (
            <button
              type="button"
              title="Move to Trash"
              onClick={onTrash}
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint hover:bg-danger-soft hover:text-danger"
            >
              ⌫
            </button>
          ) : null}
          {onDownload ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 rounded-[8px] border-line px-2.5 text-[11px]"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="hidden shrink-0 text-[10.5px] text-ink-faint sm:block">
          Open a file from the explorer
        </p>
      )}
    </header>
  );
}
