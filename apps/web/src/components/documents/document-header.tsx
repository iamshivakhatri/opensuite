"use client";

import type { ListedDocument } from "@/lib/api";
import { formatLabel } from "@/components/files/format";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { workspacePath } from "@/lib/paths";
import { cn } from "@/lib/utils";

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
 * IDE chrome — document title primary, workspace context secondary, actions grouped.
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
  dirty,
  saving,
  conflict,
  canSave,
  onSave,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
  downloading?: boolean;
  onDownload?: () => void;
  starred?: boolean;
  onToggleStar?: () => void;
  onTrash?: () => void;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
  canSave?: boolean;
  onSave?: () => void;
}) {
  const wsLabel = workspaceName?.trim() || "Workspace";

  let saveLabel = "Saved";
  if (saving) saveLabel = "Saving…";
  else if (conflict) saveLabel = "Conflict";
  else if (dirty) saveLabel = "Unsaved";

  const saveTone = conflict
    ? "text-danger"
    : dirty || saving
      ? "text-ink-soft"
      : "text-ink-faint";

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur-md">
      <Link
        href="/app"
        title="Back to workspaces"
        aria-label="Back to workspaces"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] text-[14px] text-ink-faint hover:bg-sunken hover:text-ink"
      >
        ←
      </Link>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {document ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <h1
                className="min-w-0 truncate text-[length:var(--text-sm)] font-semibold tracking-[-0.02em] text-ink"
                title={document.name}
              >
                {document.name}
              </h1>
              {document.format === "docx" ? (
                <span
                  className={cn(
                    "hidden shrink-0 text-[length:var(--text-2xs)] font-medium sm:inline",
                    saveTone,
                  )}
                  title={
                    dirty
                      ? "Unsaved changes"
                      : saving
                        ? "Saving…"
                        : conflict
                          ? "Version conflict"
                          : "All changes saved"
                  }
                >
                  {saveLabel}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-2xs)] text-ink-faint">
              <Link
                href={workspacePath(workspaceId)}
                title={`${wsLabel} — workspace home`}
                className="min-w-0 truncate hover:text-ink-soft hover:underline"
              >
                {wsLabel}
              </Link>
              <span aria-hidden className="text-ink-faint/70">
                ·
              </span>
              <span className="shrink-0 font-mono uppercase tracking-[0.04em]">
                {formatLabel(document.format)}
              </span>
            </div>
          </>
        ) : (
          <Link
            href={workspacePath(workspaceId)}
            title={`${wsLabel} — workspace home`}
            className="min-w-0 truncate text-[length:var(--text-sm)] font-semibold tracking-[-0.02em] text-ink hover:underline"
          >
            {wsLabel}
          </Link>
        )}
      </div>

      {document ? (
        <div className="flex shrink-0 items-center gap-1">
          {document.format === "docx" && onSave ? (
            <Button
              type="button"
              variant={dirty || conflict ? "primary" : "outline"}
              size="sm"
              className="h-7 px-2.5 text-[length:var(--text-xs)]"
              disabled={!canSave || saving}
              onClick={onSave}
              title="Save (⌘S)"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          ) : null}
          {onDownload ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[length:var(--text-xs)]"
              disabled={downloading}
              onClick={onDownload}
              title="Download"
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : null}
          <div className="ml-0.5 flex items-center gap-0.5 border-l border-line pl-1.5">
            {onToggleStar ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={starred ? "Unstar" : "Star"}
                aria-label={starred ? "Unstar document" : "Star document"}
                onClick={onToggleStar}
                className={cn(
                  "text-[13px]",
                  starred ? "text-accent hover:text-accent" : "text-ink-faint",
                )}
              >
                {starred ? "★" : "☆"}
              </Button>
            ) : null}
            {onTrash ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Move to Trash"
                aria-label="Move to Trash"
                onClick={onTrash}
                className="text-ink-faint hover:bg-danger-soft hover:text-danger"
              >
                <TrashIcon className="h-[14px] w-[14px]" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
