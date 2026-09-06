"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ListedDocument } from "@/lib/api";
import { workspacePath } from "@/lib/paths";

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      className={className}
      aria-hidden
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * IDE chrome — back + workspace name. Open files live in the tab strip.
 */
export function DocumentHeader({
  workspaceId,
  workspaceName,
  document,
  downloading,
  onDownload,
  starred,
  onToggleStar,
  onTrash,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
  downloading?: boolean;
  onDownload?: () => void;
  starred?: boolean;
  onToggleStar?: () => void;
  onTrash?: () => void;
}) {
  const wsLabel = workspaceName?.trim() || "Workspace";

  return (
    <header
      className="flex h-[44px] shrink-0 items-center gap-2 border-b border-line px-3"
      style={{
        background: "color-mix(in srgb, var(--surface) 88%, transparent)",
        backdropFilter: "blur(16px) saturate(1.12)",
      }}
    >
      <Link
        href="/app"
        title="Back to workspaces"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[14px] text-ink-faint hover:bg-sunken hover:text-ink"
      >
        ←
      </Link>

      <div className="flex min-w-0 flex-1 items-center">
        <Link
          href={workspacePath(workspaceId)}
          title={`${wsLabel} — workspace home`}
          className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.02em] text-ink hover:underline"
        >
          {wsLabel}
        </Link>
      </div>

      {document ? (
        <div className="flex shrink-0 items-center gap-0.5">
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
              className="grid h-7 w-7 place-items-center rounded-[8px] text-ink-faint hover:bg-danger-soft hover:text-danger"
            >
              <TrashIcon className="h-[14px] w-[14px]" />
            </button>
          ) : null}
          {onDownload ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-1 h-7 shrink-0 rounded-[var(--radius-sm)] border-line px-2.5 text-[11px]"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
