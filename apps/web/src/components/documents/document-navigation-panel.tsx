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
  canCreateBlankDocument,
  findPristineBlankDocument,
} from "@/lib/blank-document-guard";
import {
  encodeDocumentDragPayload,
  OPENSUITE_DOCUMENT_DRAG_MIME,
} from "@/lib/document-drag";
import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import { userFacingError } from "@/components/files/format";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
} from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
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
  const [addOpen, setAddOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [dropActive, setDropActive] = React.useState(false);
  const [menuDocId, setMenuDocId] = React.useState<string | null>(null);
  const [renameDoc, setRenameDoc] = React.useState<ListedDocument | null>(null);
  const [trashDoc, setTrashDoc] = React.useState<ListedDocument | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const menuAnchorRefs = React.useRef<Map<string, HTMLButtonElement>>(
    new Map(),
  );

  const pristineBlank = findPristineBlankDocument(files);
  const allowBlankCreate = canCreateBlankDocument(files);

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

  async function handleUpload(fileList: FileList | File[] | null) {
    if (!fileList || uploading) return;
    const list = Array.from(fileList as ArrayLike<File>);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const result = await uploadOfficeFiles(workspaceId, list);
      await refresh();
      if (result.uploaded.length > 0) {
        setAddOpen(false);
        toast({
          tone: "success",
          title:
            result.uploaded.length === 1
              ? "File uploaded"
              : `${result.uploaded.length} files uploaded`,
        });
        const first = result.uploaded[0]!;
        const href = documentPath(workspaceId, first.id);
        if (onRequestNavigate?.(href) !== false) {
          router.push(href);
        }
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
    if (!allowBlankCreate) {
      toast({
        tone: "error",
        title: "Finish your blank document first",
        description:
          "Rename it or make a small edit before creating another new document.",
      });
      if (pristineBlank) {
        const href = documentPath(workspaceId, pristineBlank.id);
        setAddOpen(false);
        if (onRequestNavigate?.(href) !== false) {
          router.push(href);
        }
      }
      return;
    }
    setCreating(true);
    try {
      const created = await createBlankDocument(workspaceId);
      await refresh();
      setAddOpen(false);
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
        <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[length:var(--text-sm)] text-ink-faint hover:bg-primary-soft hover:text-primary-soft">
          ›
        </span>
      </button>
    );
  }

  const menuDoc = files.find((file) => file.id === menuDocId) ?? null;
  const listLoading = documentsQuery.isPending && !documentsQuery.data;
  const modalBusy = uploading || creating;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-line bg-sidebar"
      style={{ width }}
      aria-label="Workspace files"
    >
      <div className="os-workspace-rail flex items-center gap-1.5 px-2">
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            {listLoading ? "Files" : `Files · ${files.length}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          title="Hide files"
          aria-label="Hide files"
          className={cn(
            focusRingClass,
            "grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] text-[length:var(--text-sm)] text-ink-faint hover:bg-primary-soft hover:text-primary",
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
                    "group/file flex w-full items-center gap-2.5 rounded-[var(--radius-md)] pl-2.5 pr-7 text-left os-type-label transition-colors",
                    active
                      ? "bg-primary-soft text-primary-hover ring-1 ring-inset ring-primary-line"
                      : "text-ink-soft hover:bg-primary-soft hover:text-primary",
                  )
                }
                style={{ height: "var(--explorer-row-h)" }}
                aria-current={active ? "page" : undefined}
              >
                <DocumentFormatIcon
                  format={file.format}
                  size="sm"
                  className={
                    active
                      ? "text-primary"
                      : "text-ink-faint group-hover/file:text-primary"
                  }
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
                  "absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-ink-faint opacity-0 hover:bg-primary-soft hover:text-primary focus-visible:opacity-100 group-hover:opacity-100",
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
              Press + to create or upload.
            </p>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 px-2.5 py-2.5">
        <div className="flex items-center justify-end">
          <button
            type="button"
            title="Add file"
            aria-label="Add file"
            onClick={() => setAddOpen(true)}
            className={cn(
              focusRingClass,
              "grid h-9 w-9 place-items-center rounded-[var(--radius-md)] bg-primary text-[22px] font-medium leading-none text-on-ink shadow-[0_1px_2px_color-mix(in_srgb,var(--primary)_30%,transparent)] hover:bg-primary-hover",
            )}
          >
            +
          </button>
        </div>
      </div>

      {addOpen ? (
        <Dialog
          title="Add to workspace"
          onClose={() => {
            if (modalBusy) return;
            setDropActive(false);
            setAddOpen(false);
          }}
          closeOnOverlayClick={!modalBusy}
          className="max-w-[520px]"
        >
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
            disabled={modalBusy}
            onClick={() => fileRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDropActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDropActive(false);
              void handleUpload(event.dataTransfer.files);
            }}
            className={cn(
              focusRingClass,
              "flex w-full flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed px-5 py-10 text-center transition-colors",
              dropActive
                ? "border-primary bg-primary-soft"
                : "border-line bg-sunken/40 hover:border-ink-faint hover:bg-primary-soft/70",
              modalBusy && "opacity-60",
            )}
          >
            <span className="text-[13px] font-medium text-ink">
              {uploading ? "Uploading…" : "Drop Office files here"}
            </span>
            <span className="mt-1 text-[12px] text-ink-soft">
              or click to choose .docx, .pptx, .xlsx
            </span>
          </button>

          <div className="my-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-line" />
            <span className="text-[11px] uppercase tracking-[0.06em] text-ink-faint">
              or
            </span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={modalBusy}
            onClick={() => void handleCreateBlank()}
          >
            {creating ? "Creating…" : "Create blank Word document"}
          </Button>
          {!allowBlankCreate ? (
            <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">
              You already have an unused blank document. Rename it or edit it
              before creating another.
            </p>
          ) : null}
        </Dialog>
      ) : null}

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
          tone="danger"
          busy={busy}
          error={actionError}
          onCancel={() => setTrashDoc(null)}
          onConfirm={() => void handleTrash()}
        />
      ) : null}
    </aside>
  );
}
