"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  createBlankDocument,
  deleteDocument,
  downloadDocument,
  listDocuments,
  renameDocument,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import {
  encodeDocumentDragPayload,
  OPENSUITE_DOCUMENT_DRAG_MIME,
} from "@/lib/document-drag";
import { formatLabel, userFacingError } from "@/components/files/format";
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
} from "@/components/ui/context-menu";
import { documentPath } from "@/lib/paths";
import {
  closeTabAndPickNext,
  readStoredTabs,
  writeStoredTabs,
} from "@/components/documents/document-open-tabs";
import { uploadOfficeFiles } from "@/lib/office-upload";
import { useToast } from "@/lib/toast";

/**
 * Left explorer for the workspace IDE — all files in the workspace.
 */
export function DocumentNavigationPanel({
  workspaceId,
  activeDocumentId,
  collapsed,
  onToggle,
  width = 220,
  refreshKey = 0,
  onDocumentRenamed,
  onDocumentTrashed,
  onRequestNavigate,
}: {
  workspaceId: string;
  activeDocumentId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  refreshKey?: number;
  onDocumentRenamed?: (document: ListedDocument) => void;
  onDocumentTrashed?: (documentId: string) => void;
  /** Return false to cancel navigation (dirty guard). */
  onRequestNavigate?: (href: string) => boolean | void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [siblings, setSiblings] = React.useState<ListedDocument[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
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
  }, [refresh, refreshKey]);

  async function handleUpload(fileList: FileList | null) {
    if (!fileList?.length || uploading) return;
    setUploading(true);
    try {
      const result = await uploadOfficeFiles(workspaceId, Array.from(fileList));
      await refresh();
      if (result.uploaded.length > 0) {
        toast({
          tone: "success",
          title:
            result.uploaded.length === 1
              ? "File uploaded"
              : `${result.uploaded.length} files uploaded`,
        });
      }
      if (result.rejected.length > 0) {
        toast({
          tone: "error",
          title: "Unsupported format",
          description: `Only .docx, .pptx, .xlsx — skipped ${result.rejected.length}.`,
        });
      }
      if (result.errors.length > 0) {
        toast({
          tone: "error",
          title: "Upload failed",
          description: result.errors[0],
        });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleCreateBlank() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createBlankDocument(workspaceId);
      await refresh();
      toast({ tone: "success", title: "Document created" });
      const href = documentPath(workspaceId, created.document.id);
      if (onRequestNavigate?.(href) === false) return;
      router.push(href);
    } catch (error) {
      toast({
        tone: "error",
        title: "Create failed",
        description: userFacingError(error, "Could not create a blank document."),
      });
    } finally {
      setCreating(false);
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
      toast({ tone: "success", title: "File renamed" });
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
      const { href } = closeTabAndPickNext(
        workspaceId,
        id,
        activeDocumentId,
      );
      setTrashDoc(null);
      onDocumentTrashed?.(id);
      toast({ tone: "success", title: "Moved to Trash" });
      if (href) router.push(href);
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
    <aside
      className="flex h-full shrink-0 flex-col border-r border-line bg-[var(--sidebar)]"
      style={{ width }}
    >
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pptx,.xlsx"
            multiple
            className="hidden"
            onChange={(event) => void handleUpload(event.target.files)}
          />
          <button
            type="button"
            title="New Word document"
            disabled={creating}
            onClick={() => void handleCreateBlank()}
            className="grid h-6 w-6 place-items-center rounded-[7px] text-[13px] text-ink-faint hover:bg-sunken hover:text-ink-soft disabled:opacity-50"
          >
            {creating ? "…" : "+"}
          </button>
          <button
            type="button"
            title="Upload file (⌘O)"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="grid h-6 w-6 place-items-center rounded-[7px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink-soft disabled:opacity-50"
          >
            {uploading ? "…" : "↑"}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 [scrollbar-width:thin]">
        <div className="mb-1.5 px-2 font-mono text-[8.5px] font-medium uppercase tracking-[0.07em] text-ink-faint">
          Files{siblings ? ` · ${files.length}` : ""}
        </div>

        {loadError ? (
          <p className="px-2 text-[10.5px] leading-relaxed text-danger">
            {loadError}
          </p>
        ) : null}

        {siblings === null && !loadError ? (
          <p className="px-2 text-[10.5px] text-ink-faint">Loading…</p>
        ) : null}

        {files.map((file) => {
          const active = file.id === activeDocumentId;
          return (
            <div
              key={file.id}
              className="group relative"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  OPENSUITE_DOCUMENT_DRAG_MIME,
                  encodeDocumentDragPayload({
                    id: file.id,
                    name: file.name,
                    format: file.format,
                    workspaceId,
                  }),
                );
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              <Link
                href={documentPath(workspaceId, file.id)}
                title={`${file.name} — drag into chat to tag`}
                prefetch
                onClick={(event) => {
                  const href = documentPath(workspaceId, file.id);
                  if (onRequestNavigate) {
                    event.preventDefault();
                    if (onRequestNavigate(href) === false) return;
                    router.push(href);
                  }
                }}
                className={`flex w-full items-center gap-2 rounded-[8px] py-1.5 pl-2 pr-7 text-left text-[11px] transition-colors ${
                  active
                    ? "bg-accent-soft font-medium text-accent-hover"
                    : "text-ink-soft hover:bg-sunken hover:text-ink"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-[2px] border ${
                    active ? "border-current bg-current/20" : "border-ink-faint"
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
          <div className="mx-1 mt-2 rounded-[10px] border border-dashed border-line px-2.5 py-4 text-center">
            <p className="text-[11px] font-medium text-ink">No files yet</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
              Upload with ↑ or drag Office files here.
            </p>
          </div>
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
              onSelect: () => {
                const href = documentPath(workspaceId, menuDoc.id);
                if (onRequestNavigate?.(href) === false) return;
                router.push(href);
              },
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
                void setDocumentStarred(menuDoc.id, next)
                  .then(() =>
                    toast({
                      tone: "success",
                      title: next ? "Starred" : "Unstarred",
                    }),
                  )
                  .catch(() => {
                    setSiblings((current) =>
                      (current ?? []).map((item) =>
                        item.id === menuDoc.id
                          ? { ...item, starred: !next }
                          : item,
                      ),
                    );
                    toast({ tone: "error", title: "Could not update star" });
                  });
              },
            },
            {
              id: "download",
              label: "Download",
              onSelect: () => {
                void downloadDocument(menuDoc.id).catch(() => {
                  toast({ tone: "error", title: "Download failed" });
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
