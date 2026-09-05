"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatBytes, formatLabel } from "@/components/files/format";
import type { ListedDocument } from "@/lib/api";

/**
 * Compact header for the workspace IDE — workspace home or active file.
 */
export function DocumentHeader({
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
  return (
    <header
      className="flex h-[48px] shrink-0 items-center gap-3 border-b border-line px-3.5 backdrop-saturate-150"
      style={{
        background: "color-mix(in srgb, var(--surface) 86%, transparent)",
        backdropFilter: "blur(18px) saturate(1.18)",
      }}
    >
      <Link
        href="/app"
        className="shrink-0 text-[10.5px] font-medium text-ink-faint hover:text-ink"
      >
        ← Workspaces
      </Link>
      <div className="h-3.5 w-px shrink-0 bg-line" />
      {document ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              title="Rename"
              onClick={onRename}
              className="truncate text-left text-[11.5px] font-semibold text-ink hover:underline"
            >
              {document.name}
            </button>
            <span className="shrink-0 rounded-full border border-line bg-surface px-[6px] py-[2px] font-mono text-[7.5px] font-medium text-ink-faint">
              {formatLabel(document.format)}
            </span>
          </div>
          <div className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
            Version {document.latestVersion.versionNumber} ·{" "}
            {formatBytes(document.latestVersion.sizeBytes)}
          </div>
          {onToggleStar ? (
            <button
              type="button"
              title={starred ? "Unstar" : "Star"}
              onClick={onToggleStar}
              className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-[14px] text-ink-faint hover:bg-sunken hover:text-accent"
            >
              {starred ? "★" : "☆"}
            </button>
          ) : null}
          {onTrash ? (
            <button
              type="button"
              title="Move to Trash"
              onClick={onTrash}
              className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-[12px] text-ink-faint hover:bg-danger-soft hover:text-danger"
            >
              ⌫
            </button>
          ) : null}
          {onDownload ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-[30px] shrink-0 rounded-[9px] border-line px-[10px] text-[11px]"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11.5px] font-semibold text-ink">
              {workspaceName?.trim() || "Workspace"}
            </span>
            <span className="shrink-0 rounded-full border border-line bg-surface px-[6px] py-[2px] font-mono text-[7.5px] font-medium text-ink-faint">
              WS
            </span>
          </div>
          <div className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
            Open any file from the explorer — Word, PowerPoint, or Excel.
          </div>
        </>
      )}
    </header>
  );
}
