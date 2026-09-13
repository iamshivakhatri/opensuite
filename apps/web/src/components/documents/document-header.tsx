"use client";

import type { ListedDocument } from "@/lib/api";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { focusRingClass } from "@/lib/focus-scope";
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
 * IDE top chrome — workspace identity + document actions.
 * Filename lives in the tab strip; do not repeat it here.
 */
export function DocumentHeader({
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
  onRenameWorkspace,
}: {
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
  onRenameWorkspace?: () => void;
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
        title="Back to Home"
        aria-label="Back to Home"
        className={cn(
          focusRingClass,
          "grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] text-[length:var(--text-md)] text-ink-faint hover:bg-primary-soft hover:text-primary",
        )}
      >
        ←
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <h1
          className="min-w-0 truncate text-[length:var(--text-sm)] font-medium tracking-[-0.02em] text-ink-soft"
          title={wsLabel}
        >
          {wsLabel}
        </h1>
        {onRenameWorkspace ? (
          <button
            type="button"
            title="Rename workspace"
            aria-label="Rename workspace"
            onClick={onRenameWorkspace}
            className={cn(
              focusRingClass,
              "os-type-meta shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-ink-faint hover:bg-primary-soft hover:text-primary-soft",
            )}
          >
            Rename
          </button>
        ) : null}
        {document?.format === "docx" ? (
          <span
            className={cn(
              "os-type-meta hidden shrink-0 sm:inline",
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

      {document ? (
        <div className="flex shrink-0 items-center gap-1">
          {document.format === "docx" && onSave ? (
            <Button
              type="button"
              variant={dirty || conflict ? "primary" : "secondary"}
              size="sm"
              className="h-7 px-2.5 text-[length:var(--text-sm)]"
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
              variant="secondary"
              size="sm"
              className="h-7 px-2.5 text-[length:var(--text-sm)]"
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
                aria-pressed={starred}
                onClick={onToggleStar}
                className={cn(
                  "text-[length:var(--text-sm)]",
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
