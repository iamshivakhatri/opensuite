"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  deleteDocument,
  downloadDocument,
  listDocuments,
  renameDocument,
  setDocumentStarred,
  uploadDocument,
  type ListedDocument,
} from "@/lib/api";
import { formatLabel, userFacingError } from "@/components/files/format";
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
} from "@/components/ui/context-menu";
import { documentPath, workspacePath } from "@/lib/paths";
import {
  readStoredTabs,
  removeStoredTab,
  writeStoredTabs,
} from "@/components/documents/document-open-tabs";

/**
 * Left explorer for the workspace IDE — all files in the workspace.
 */
export function DocumentNavigationPanel({
  workspaceId,
  activeDocumentId,
  collapsed,
  onToggle,
  onDocumentRenamed,
  onDocumentTrashed,
}: {
  workspaceId: string;
  activeDocumentId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onDocumentRenamed?: (document: ListedDocument) => void;
  onDocumentTrashed?: (documentId: string) => void;
}) {
  const router = useRouter();
  const [siblings, setSiblings] = React.useState<ListedDocument[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [menuDocId, setMenuDocId] = React.useState<string | null>(null);
  const [renameDoc, setRenameDoc] = React.useState<ListedDocument | null>(null);
  const [trashDoc, setTrashDoc] = React.useState<ListedDocument | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const menuAnchorRefs = React.useRef<Map<string, HTMLButtonElement>>(
    new Map(),
  );

  const refresh = React.useCallback(async () => {
    setLoadError(null);
    try {
      setSiblings(await listDocuments(workspaceId));
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

  async function handleRename(name: string) {
    if (!renameDoc || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await renameDocument(renameDoc.id, name);
      setSiblings((current) =>
        (current ?? []).map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      const tabs = readStoredTabs(workspaceId).map((tab) =>
        tab.id === updated.id
          ? { ...tab, name: updated.name, format: updated.format }
          : tab,
      );
      writeStoredTabs(workspaceId, tabs);
      onDocumentRenamed?.(updated);
      setRenameDoc(null);
    } catch (error) {
      setActionError(userFacingError(error, "Could not rename file."));
    } finally {
      setBusy(false);
    }
  }

  async function handleTrash() {
    if (!trashDoc || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const id = trashDoc.id;
      await deleteDocument(id);
      setSiblings((current) => (current ?? []).filter((item) => item.id !== id));
      removeStoredTab(workspaceId, id);
      setTrashDoc(null);
      onDocumentTrashed?.(id);
      if (activeDocumentId === id) {
        const remaining = readStoredTabs(workspaceId);
        const fallback = remaining[remaining.length - 1];
        if (fallback) {
          router.push(documentPath(workspaceId, fallback.id));
        } else {
          router.push(workspacePath(workspaceId));
        }
      }
    } catch (error) {
      setActionError(userFacingError(error, "Could not move file to Trash."));
    } finally {
      setBusy(false);
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
  const menuDoc = files.find((file) => file.id === menuDocId) ?? null;

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
          return (
            <div key={file.id} className="group relative">
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
              <button
                type="button"
                title="File actions"
                ref={(node) => {
                  if (node) menuAnchorRefs.current.set(file.id, node);
                  else menuAnchorRefs.current.delete(file.id);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuDocId((current) =>
                    current === file.id ? null : file.id,
                  );
                }}
                className="absolute right-0.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-[11px] text-ink-faint opacity-0 hover:bg-sunken hover:text-ink group-hover:opacity-100"
              >
                ···
              </button>
            </div>
          );
        })}

        {siblings !== null && files.length === 0 ? (
          <p className="px-2 text-[10.5px] text-ink-faint">
            No files yet. Upload with ↑.
          </p>
        ) : null}
      </div>

      {menuDoc ? (
        <ContextMenu
          open={menuDocId === menuDoc.id}
          onClose={() => setMenuDocId(null)}
          anchorRef={{
            current: menuAnchorRefs.current.get(menuDoc.id) ?? null,
          }}
          items={[
            {
              id: "open",
              label: "Open",
              onSelect: () =>
                router.push(documentPath(workspaceId, menuDoc.id)),
            },
            {
              id: "rename",
              label: "Rename",
              onSelect: () => {
                setActionError(null);
                setRenameDoc(menuDoc);
              },
            },
            {
              id: "star",
              label: menuDoc.starred ? "Unstar" : "Star",
              onSelect: () => {
                const next = !menuDoc.starred;
                setSiblings((current) =>
                  (current ?? []).map((item) =>
                    item.id === menuDoc.id ? { ...item, starred: next } : item,
                  ),
                );
                void setDocumentStarred(menuDoc.id, next).catch(() => {
                  setSiblings((current) =>
                    (current ?? []).map((item) =>
                      item.id === menuDoc.id
                        ? { ...item, starred: !next }
                        : item,
                    ),
                  );
                });
              },
            },
            {
              id: "download",
              label: "Download",
              onSelect: () => {
                void downloadDocument(menuDoc.id).catch(() => {
                  setUploadError("Could not download this file.");
                });
              },
            },
            {
              id: "trash",
              label: "Move to Trash",
              danger: true,
              onSelect: () => {
                setActionError(null);
                setTrashDoc(menuDoc);
              },
            },
          ]}
        />
      ) : null}

      {renameDoc ? (
        <PromptDialog
          title="Rename file"
          initialValue={renameDoc.name}
          busy={busy}
          error={actionError}
          onCancel={() => setRenameDoc(null)}
          onSubmit={(name) => void handleRename(name)}
        />
      ) : null}

      {trashDoc ? (
        <ConfirmDialog
          title="Move to Trash?"
          body={
            <>
              Move{" "}
              <span className="font-medium text-ink">{trashDoc.name}</span> to
              Trash. You can restore it later.
            </>
          }
          confirmLabel="Move to Trash"
          busy={busy}
          error={actionError}
          onCancel={() => setTrashDoc(null)}
          onConfirm={() => void handleTrash()}
        />
      ) : null}
    </aside>
  );
}
