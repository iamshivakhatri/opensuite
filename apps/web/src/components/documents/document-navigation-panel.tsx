"use client";

import * as React from "react";
import Link from "next/link";

import {
  listDocuments,
  setDocumentStarred,
  uploadDocument,
  type ListedDocument,
} from "@/lib/api";
import { formatLabel, userFacingError } from "@/components/files/format";
import { documentPath, workspacePath } from "@/lib/paths";

/**
 * Left explorer for the workspace IDE — all files in the workspace.
 */
export function DocumentNavigationPanel({
  workspaceId,
  activeDocumentId,
  collapsed,
  onToggle,
}: {
  workspaceId: string;
  activeDocumentId: string | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [siblings, setSiblings] = React.useState<ListedDocument[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async () => {
    setLoadError(null);
    try {
      const docs = await listDocuments(workspaceId);
      setSiblings(docs);
    } catch (error) {
      setLoadError(userFacingError(error, "Could not load workspace files."));
    }
  }, [workspaceId]);

  React.useEffect(() => {
    setSiblings(null);
    void refresh();
  }, [refresh]);

  async function handleUpload(file: File | undefined) {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadDocument(workspaceId, file);
      await refresh();
    } catch (error) {
      setUploadError(userFacingError(error, "Upload failed."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function toggleStar(event: React.MouseEvent, doc: ListedDocument) {
    event.preventDefault();
    event.stopPropagation();
    const next = !doc.starred;
    setSiblings((current) =>
      (current ?? []).map((item) =>
        item.id === doc.id ? { ...item, starred: next } : item,
      ),
    );
    try {
      await setDocumentStarred(doc.id, next);
    } catch {
      setSiblings((current) =>
        (current ?? []).map((item) =>
          item.id === doc.id ? { ...item, starred: !next } : item,
        ),
      );
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show files"
        className="flex h-full w-10 shrink-0 flex-col items-center border-r border-line bg-[var(--sidebar)] pt-3"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[9px] text-[13px] text-ink-faint hover:bg-sunken hover:text-ink-soft">
          ›
        </span>
      </button>
    );
  }

  const files = siblings ?? [];

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-line bg-[var(--sidebar)]">
      <div className="flex items-center justify-between px-2.5 py-2.5">
        <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pptx,.xlsx"
            className="hidden"
            onChange={(event) =>
              void handleUpload(event.target.files?.[0] ?? undefined)
            }
          />
          <button
            type="button"
            title="Upload file"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="grid h-6 w-6 place-items-center rounded-[7px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink-soft disabled:opacity-50"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onToggle}
            title="Hide files"
            className="grid h-6 w-6 place-items-center rounded-[7px] text-[11px] text-ink-faint hover:bg-sunken hover:text-ink-soft"
          >
            ‹
          </button>
        </div>
      </div>

      <div className="px-2 pb-2">
        <Link
          href={workspacePath(workspaceId)}
          className={`flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-[12px] ${
            activeDocumentId === null
              ? "bg-accent-soft font-medium text-accent-hover"
              : "text-ink-soft hover:bg-sunken hover:text-ink"
          }`}
        >
          <span className="text-[13px] text-ink-faint">▦</span>
          Workspace
        </Link>
        <Link
          href="/app"
          className="mt-0.5 flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-[12px] text-ink-soft hover:bg-sunken hover:text-ink"
        >
          <span className="text-[13px] text-ink-faint">←</span>
          Workspaces
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <div className="mb-1.5 px-2 font-mono text-[8.5px] font-medium uppercase tracking-[0.07em] text-ink-faint">
          Files
        </div>

        {loadError ? (
          <p className="px-2 text-[10.5px] leading-relaxed text-danger">
            {loadError}
          </p>
        ) : null}
        {uploadError ? (
          <p className="px-2 text-[10.5px] leading-relaxed text-danger">
            {uploadError}
          </p>
        ) : null}

        {siblings === null && !loadError ? (
          <p className="px-2 text-[10.5px] text-ink-faint">Loading…</p>
        ) : null}

        {files.map((file) => {
          const active = file.id === activeDocumentId;
          const starred = Boolean(file.starred);
          const showStar = hoverId === file.id || starred || active;
          return (
            <div
              key={file.id}
              className="relative"
              onMouseEnter={() => setHoverId(file.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              <Link
                href={documentPath(workspaceId, file.id)}
                className={`flex w-full items-center gap-2 rounded-[8px] py-1.5 pl-2 pr-7 text-left text-[11px] ${
                  active
                    ? "bg-accent-soft font-medium text-accent-hover"
                    : "text-ink-soft hover:bg-sunken hover:text-ink"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-[2px] border ${
                    active ? "border-current" : "border-ink-faint"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 font-mono text-[7.5px] uppercase text-ink-faint">
                  {formatLabel(file.format)}
                </span>
              </Link>
              {showStar ? (
                <button
                  type="button"
                  title={starred ? "Unstar" : "Star"}
                  onClick={(event) => void toggleStar(event, file)}
                  className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-[11px] text-ink-faint hover:text-accent"
                >
                  {starred ? "★" : "☆"}
                </button>
              ) : null}
            </div>
          );
        })}

        {siblings !== null && files.length === 0 ? (
          <p className="px-2 text-[10.5px] text-ink-faint">
            No files yet. Upload with ↑.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
