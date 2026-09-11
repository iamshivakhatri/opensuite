"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createBlankDocument,
  deleteDocument,
  downloadDocument,
  renameDocument,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import {
  encodeDocumentDragPayload,
  OPENSUITE_DOCUMENT_DRAG_MIME,
} from "@/lib/document-drag";
import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import { userFacingError } from "@/components/files/format";
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
} from "@/components/ui/context-menu";
import { documentPath } from "@/lib/paths";
import {
  queryKeys,
  workspaceDocumentsQuery,
} from "@/lib/query-keys";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";
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
  const queryClient = useQueryClient();
  const documentsQuery = useQuery({
    ...workspaceDocumentsQuery(workspaceId),
    // refreshKey forces a refetch after agent/create events from the IDE.
  });

  React.useEffect(() => {
    if (refreshKey > 0) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDocuments(workspaceId),
      });
    }
  }, [refreshKey, queryClient, workspaceId]);

  const files = documentsQuery.data ?? [];
  const loadError = documentsQuery.error
    ? userFacingError(documentsQuery.error, "Could not load workspace files.")
    : null;
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

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.workspaceDocuments(workspaceId),
    });
  }

  function patchList(
    updater: (current: ListedDocument[]) => ListedDocument[],
  ) {
    queryClient.setQueryData<ListedDocument[]>(
      queryKeys.workspaceDocuments(workspaceId),
      (current) => updater(current ?? []),
    );
  }

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
      patchList((current) =>
        current.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      queryClient.setQueryData(queryKeys.document(updated.id), updated);
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
      patchList((current) => current.filter((item) => item.id !== id));
      queryClient.removeQueries({ queryKey: queryKeys.document(id) });
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
        aria-label="Show files"
        className={cn(
          focusRingClass,
          "flex h-full w-10 shrink-0 flex-col items-center border-r border-line bg-sidebar pt-3",
        )}
      >
        <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[length:var(--text-sm)] text-ink-faint hover:bg-sunken hover:text-ink-soft">
          ›
        </span>
      </button>
    );
  }

  const menuDoc = files.find((file) => file.id === menuDocId) ?? null;
  const listLoading = documentsQuery.isPending && !documentsQuery.data;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-line bg-sidebar"
      style={{ width }}
      aria-label="Workspace files"
    >
      <div className="os-workspace-rail flex items-center justify-end gap-0.5 px-2">
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
          aria-label="New Word document"
          disabled={creating}
          onClick={() => void handleCreateBlank()}
          className={cn(
            focusRingClass,
            "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-sm)] text-ink-faint hover:bg-sunken hover:text-ink disabled:opacity-50",
          )}
        >
          {creating ? "…" : "+"}
        </button>
        <button
          type="button"
          title="Upload file (⌘O)"
          aria-label="Upload file"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className={cn(
            focusRingClass,
            "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-ink-faint hover:bg-sunken hover:text-ink disabled:opacity-50",
          )}
        >
          {uploading ? "…" : "↑"}
        </button>
        <button
          type="button"
          onClick={onToggle}
          title="Hide files"
          aria-label="Hide files"
          className={cn(
            focusRingClass,
            "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-ink-faint hover:bg-sunken hover:text-ink",
          )}
        >
          ‹
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]"
        style={{
          gap: "var(--explorer-list-gap)",
          padding: "var(--explorer-list-pad)",
        }}
      >
        {loadError ? (
          <p className="os-type-meta px-2 leading-relaxed text-danger">
            {loadError}
          </p>
        ) : null}

        {listLoading && !loadError ? (
          <div
            className="flex flex-col"
            style={{ gap: "var(--explorer-list-gap)" }}
            aria-hidden
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="os-shimmer rounded-[var(--radius-md)]"
                style={{
                  height: "var(--explorer-row-h)",
                  width: `${78 - (i % 3) * 10}%`,
                }}
              />
            ))}
          </div>
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
                className={
                  cn(
                    focusRingClass,
                    "flex w-full items-center gap-2.5 rounded-[var(--radius-md)] pl-2.5 pr-7 text-left os-type-label transition-colors",
                    active
                      ? "bg-accent-soft text-accent-hover"
                      : "text-ink-soft hover:bg-sunken hover:text-ink",
                  )
                }
                style={{ height: "var(--explorer-row-h)" }}
                aria-current={active ? "page" : undefined}
              >
                <DocumentFormatIcon
                  format={file.format}
                  size="sm"
                  className={active ? "text-accent-hover" : "text-ink-faint"}
                />
                <span className="min-w-0 flex-1 truncate leading-none">
                  {file.name}
                </span>
              </Link>
              <button
                type="button"
                title="File actions"
                aria-label={`Actions for ${file.name}`}
                aria-haspopup="menu"
                aria-expanded={menuDocId === file.id}
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
                className={cn(
                  focusRingClass,
                  "absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-ink-faint opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover:opacity-100",
                )}
              >
                ···
              </button>
            </div>
          );
        })}

        {!listLoading && files.length === 0 ? (
          <div className="mt-1 rounded-[var(--radius-md)] border border-dashed border-line px-2.5 py-5 text-center">
            <p className="os-type-label text-ink-soft">No files yet</p>
            <p className="os-type-meta mt-1.5 leading-relaxed text-ink-faint">
              Upload with ↑ or drag Office files here.
            </p>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line px-2.5 py-2">
        <p className="os-type-meta text-ink-faint">
          {listLoading ? "Files" : `Files · ${files.length}`}
        </p>
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
                patchList((current) =>
                  current.map((item) =>
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
                    patchList((current) =>
                      current.map((item) =>
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
