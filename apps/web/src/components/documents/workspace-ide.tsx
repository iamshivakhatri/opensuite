"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { DocumentHeader } from "@/components/documents/document-header";
import { DocumentNavigationPanel } from "@/components/documents/document-navigation-panel";
import {
  closeTabAndPickNext,
  DocumentOpenTabs,
} from "@/components/documents/document-open-tabs";
import { DocumentSurface } from "@/components/documents/surfaces/document-surface";
import type { DocxSurfaceStatus } from "@/components/documents/surfaces/docx-surface";
import { DocumentAgentPanel } from "@/components/documents/document-agent-panel";
import {
  deleteDocument,
  downloadDocument,
  renameWorkspace,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import { userFacingError } from "@/components/files/format";
import { ConfirmDialog } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import {
  PANEL_LIMITS,
  readIdePanelPrefs,
  writeIdePanelPrefs,
} from "@/lib/ide-prefs";
import { uploadOfficeFiles } from "@/lib/office-upload";
import { useToast } from "@/lib/toast";
import { useCommandPalette } from "@/components/shell/command-palette";
import { documentPath } from "@/lib/paths";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

/**
 * Cursor-like workspace IDE: explorer + tabs + canvas + agent.
 */
export function WorkspaceIde({
  workspaceId,
  workspaceName,
  document,
  documentId = null,
  documentPending = false,
  onWorkspaceRenamed,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
  /** Route document id — drives tab selection before fetch resolves. */
  documentId?: string | null;
  documentPending?: boolean;
  onWorkspaceRenamed?: (name: string) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { setOpen: openPalette } = useCommandPalette();
  const prefs = React.useMemo(() => readIdePanelPrefs(), []);

  const [explorerWidth, setExplorerWidth] = React.useState(prefs.explorerWidth);
  const [agentWidth, setAgentWidth] = React.useState(prefs.agentWidth);
  const [navCollapsed, setNavCollapsed] = React.useState(
    prefs.explorerCollapsed,
  );
  const [agentCollapsed, setAgentCollapsed] = React.useState(
    prefs.agentCollapsed,
  );
  const [downloading, setDownloading] = React.useState(false);
  const [activeDocument, setActiveDocument] =
    React.useState<ListedDocument | null>(document);
  const [starred, setStarred] = React.useState(Boolean(document?.starred));
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = React.useState(false);
  const [renameWorkspaceValue, setRenameWorkspaceValue] = React.useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = React.useState(false);
  const [renameWorkspaceError, setRenameWorkspaceError] = React.useState<
    string | null
  >(null);
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [tabsRevision, setTabsRevision] = React.useState(0);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [draggingOver, setDraggingOver] = React.useState(false);
  const [uploadingDrop, setUploadingDrop] = React.useState(false);
  const [editorStatus, setEditorStatus] = React.useState<DocxSurfaceStatus>({
    dirty: false,
    saving: false,
    conflict: false,
    loadedVersionId: null,
    latestVersionId: null,
  });
  const [saveRequestId, setSaveRequestId] = React.useState(0);
  const dragDepth = React.useRef(0);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    // Keep the previous document mounted while the next fetch resolves so the
    // canvas does not flash empty on every tab click.
    if (!documentId) {
      setActiveDocument(null);
      setStarred(false);
      return;
    }
    if (document && document.id === documentId) {
      setActiveDocument(document);
      setStarred(Boolean(document.starred));
    }
  }, [document, documentId]);

  // Reset editor chrome only when the open file identity changes — not on
  // every latestVersion bump (agent writes), which caused header flicker.
  React.useEffect(() => {
    setEditorStatus({
      dirty: false,
      saving: false,
      conflict: false,
      loadedVersionId: null,
      latestVersionId: document?.latestVersion.id ?? null,
    });
  }, [document?.id]);

  React.useEffect(() => {
    writeIdePanelPrefs({
      explorerWidth,
      agentWidth,
      explorerCollapsed: navCollapsed,
      agentCollapsed,
    });
  }, [explorerWidth, agentWidth, navCollapsed, agentCollapsed]);

  const isDirty = editorStatus.dirty || editorStatus.saving;

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    );
  }

  const closeActiveTab = React.useCallback(() => {
    if (!activeDocument) return;
    const { href } = closeTabAndPickNext(
      workspaceId,
      activeDocument.id,
      activeDocument.id,
    );
    setTabsRevision((value) => value + 1);
    if (href) router.push(href);
  }, [activeDocument, router, workspaceId]);

  const requestCloseTab = React.useCallback(
    (documentId: string): boolean => {
      const closingActive = activeDocument?.id === documentId;
      if (!closingActive || !isDirty) return true;
      setPendingHref(`__close__:${documentId}`);
      setDiscardOpen(true);
      return false;
    },
    [activeDocument?.id, isDirty],
  );

  const requestNavigate = React.useCallback(
    (href: string): boolean => {
      if (!isDirty) return true;
      if (
        activeDocument &&
        href === documentPath(workspaceId, activeDocument.id)
      ) {
        return true;
      }
      setPendingHref(href);
      setDiscardOpen(true);
      return false;
    },
    [activeDocument, isDirty, workspaceId],
  );

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "w") {
        if (!activeDocument) return;
        event.preventDefault();
        if (requestCloseTab(activeDocument.id)) {
          closeActiveTab();
        }
      } else if (key === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
      }
    }
    function onUploadRequest(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      fileInputRef.current?.click();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(
      "opensuite:upload-request",
      onUploadRequest as EventListener,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(
        "opensuite:upload-request",
        onUploadRequest as EventListener,
      );
    };
  }, [activeDocument, closeActiveTab, requestCloseTab, workspaceId]);

  async function runUploads(files: File[]) {
    if (files.length === 0 || uploadingDrop) return;
    setUploadingDrop(true);
    try {
      const result = await uploadOfficeFiles(workspaceId, files);
      setRefreshKey((value) => value + 1);
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
          description: "Only .docx, .pptx, and .xlsx are supported.",
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
      setUploadingDrop(false);
    }
  }

  async function handleDownload() {
    if (!activeDocument || downloading) return;
    setDownloading(true);
    try {
      await downloadDocument(activeDocument.id);
    } catch (error) {
      toast({
        tone: "error",
        title: "Download failed",
        description: userFacingError(error, "Could not download this file."),
      });
    } finally {
      setDownloading(false);
    }
  }

  async function handleToggleStar() {
    if (!activeDocument) return;
    const next = !starred;
    setStarred(next);
    try {
      await setDocumentStarred(activeDocument.id, next);
      setActiveDocument({ ...activeDocument, starred: next });
      toast({ tone: "success", title: next ? "Starred" : "Unstarred" });
    } catch {
      setStarred(!next);
      toast({ tone: "error", title: "Could not update star" });
    }
  }

  async function handleTrash() {
    if (!activeDocument || busy) return;
    if (isDirty) {
      setTrashOpen(false);
      setPendingHref(`__trash__:${activeDocument.id}`);
      setDiscardOpen(true);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const id = activeDocument.id;
      await deleteDocument(id);
      setTrashOpen(false);
      setActiveDocument(null);
      toast({ tone: "success", title: "Moved to Trash" });
      const { href } = closeTabAndPickNext(workspaceId, id, id);
      queryClient.removeQueries({ queryKey: queryKeys.document(id) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDocuments(workspaceId),
      });
      setTabsRevision((value) => value + 1);
      setRefreshKey((value) => value + 1);
      if (href) router.push(href);
    } catch (error) {
      setActionError(userFacingError(error, "Could not move file to Trash."));
    } finally {
      setBusy(false);
    }
  }

  function onDragEnter(event: React.DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDraggingOver(true);
  }

  function onDragLeave(event: React.DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingOver(false);
  }

  function onDragOver(event: React.DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingOver(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    void runUploads(files);
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-paper"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,.pptx,.xlsx"
        multiple
        className="hidden"
        onChange={(event) => {
          void runUploads(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <DocumentHeader
        workspaceName={workspaceName}
        document={activeDocument}
        downloading={downloading}
        onDownload={activeDocument ? () => void handleDownload() : undefined}
        starred={starred}
        onToggleStar={activeDocument ? () => void handleToggleStar() : undefined}
        onTrash={
          activeDocument
            ? () => {
                setActionError(null);
                setTrashOpen(true);
              }
            : undefined
        }
        dirty={editorStatus.dirty}
        saving={editorStatus.saving}
        conflict={editorStatus.conflict}
        canSave={
          Boolean(activeDocument?.format === "docx") &&
          !editorStatus.saving &&
          !editorStatus.conflict &&
          Boolean(editorStatus.loadedVersionId)
        }
        onSave={
          activeDocument?.format === "docx"
            ? () => setSaveRequestId((value) => value + 1)
            : undefined
        }
        onRenameWorkspace={() => {
          setRenameWorkspaceError(null);
          setRenameWorkspaceValue(workspaceName?.trim() || "");
          setRenameWorkspaceOpen(true);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <DocumentNavigationPanel
          workspaceId={workspaceId}
          activeDocumentId={documentId ?? activeDocument?.id ?? null}
          collapsed={navCollapsed}
          width={explorerWidth}
          refreshKey={refreshKey}
          onToggle={() => setNavCollapsed((value) => !value)}
          onRequestNavigate={requestNavigate}
          onDocumentRenamed={(updated) => {
            if (activeDocument?.id === updated.id) {
              setActiveDocument({ ...activeDocument, ...updated });
            }
            setTabsRevision((value) => value + 1);
          }}
          onDocumentTrashed={(trashedId) => {
            // Clear active doc before tab revision so the strip does not
            // upsert the deleted id back from sessionStorage.
            setActiveDocument((current) =>
              current?.id === trashedId ? null : current,
            );
            setRefreshKey((value) => value + 1);
            setTabsRevision((value) => value + 1);
          }}
        />
        {!navCollapsed ? (
          <ResizeHandle
            side="left"
            onResize={(delta) =>
              setExplorerWidth((width) =>
                Math.min(
                  PANEL_LIMITS.explorerMax,
                  Math.max(PANEL_LIMITS.explorerMin, width + delta),
                ),
              )
            }
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DocumentOpenTabs
            workspaceId={workspaceId}
            activeDocument={activeDocument}
            activeDocumentId={documentId}
            revision={tabsRevision}
            dirtyDocumentId={
              editorStatus.dirty &&
              activeDocument &&
              activeDocument.id === documentId
                ? activeDocument.id
                : null
            }
            onRequestCloseTab={requestCloseTab}
            onRequestNavigate={requestNavigate}
          />
          {documentId && activeDocument ? (
            <DocumentSurface
              key={activeDocument.id}
              document={activeDocument}
              saveRequestId={saveRequestId}
              onStatusChange={setEditorStatus}
              onDocumentUpdated={(updated) => {
                setActiveDocument(updated);
                queryClient.setQueryData(
                  queryKeys.document(updated.id),
                  updated,
                );
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.workspaceDocuments(workspaceId),
                });
                setRefreshKey((value) => value + 1);
              }}
            />
          ) : documentId || documentPending ? (
            <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-sunken">
              <p className="os-type-secondary text-ink-faint">Opening file…</p>
            </div>
          ) : (
            <WorkspaceHomeCanvas
              onUpload={() => fileInputRef.current?.click()}
              onSearch={() => openPalette(true)}
            />
          )}
        </div>

        {!agentCollapsed ? (
          <ResizeHandle
            side="right"
            onResize={(delta) =>
              setAgentWidth((width) =>
                Math.min(
                  PANEL_LIMITS.agentMax,
                  Math.max(PANEL_LIMITS.agentMin, width - delta),
                ),
              )
            }
          />
        ) : null}
        <DocumentAgentPanel
          workspaceId={workspaceId}
          documentId={activeDocument?.id ?? null}
          documentName={activeDocument?.name}
          collapsed={agentCollapsed}
          width={agentWidth}
          onToggle={() => setAgentCollapsed((value) => !value)}
          onDocumentUpdated={(updated) => {
            setActiveDocument(updated);
            queryClient.setQueryData(queryKeys.document(updated.id), updated);
          }}
          onDocumentCreated={(created) => {
            queryClient.setQueryData(queryKeys.document(created.id), created);
            void queryClient.invalidateQueries({
              queryKey: queryKeys.workspaceDocuments(workspaceId),
            });
            setRefreshKey((value) => value + 1);
            setActiveDocument(created);
          }}
        />
      </div>

      {draggingOver || uploadingDrop ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-overlay backdrop-blur-[2px]">
          <div className="rounded-[var(--radius-lg)] border border-dashed border-accent bg-surface px-8 py-7 text-center shadow-[var(--elevation-md)]">
            <p className="text-[length:var(--text-md)] font-semibold tracking-[-0.02em] text-ink">
              {uploadingDrop ? "Uploading…" : "Drop Office files to upload"}
            </p>
            <p className="os-type-secondary mt-1 text-ink-soft">
              .docx · .pptx · .xlsx
            </p>
          </div>
        </div>
      ) : null}

      {trashOpen && activeDocument ? (
        <ConfirmDialog
          title="Move to Trash?"
          body={
            <>
              Move{" "}
              <span className="font-medium text-ink">{activeDocument.name}</span>{" "}
              to Trash. You can restore it later.
            </>
          }
          confirmLabel="Move to Trash"
          tone="danger"
          busy={busy}
          error={actionError}
          onCancel={() => setTrashOpen(false)}
          onConfirm={() => void handleTrash()}
        />
      ) : null}

      {renameWorkspaceOpen ? (
        <Dialog
          onClose={() => setRenameWorkspaceOpen(false)}
          title="Rename workspace"
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                const next = renameWorkspaceValue.trim();
                if (!next || renameWorkspaceBusy) return;
                setRenameWorkspaceBusy(true);
                setRenameWorkspaceError(null);
                try {
                  const updated = await renameWorkspace(workspaceId, next);
                  onWorkspaceRenamed?.(updated.name);
                  setRenameWorkspaceOpen(false);
                  toast({ tone: "success", title: "Workspace renamed" });
                } catch (error) {
                  setRenameWorkspaceError(
                    userFacingError(error, "Could not rename workspace."),
                  );
                } finally {
                  setRenameWorkspaceBusy(false);
                }
              })();
            }}
          >
            <Input
              autoFocus
              value={renameWorkspaceValue}
              onChange={(event) => setRenameWorkspaceValue(event.target.value)}
              maxLength={100}
              placeholder="Workspace name"
            />
            {renameWorkspaceError ? (
              <p className="os-type-meta text-danger">{renameWorkspaceError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRenameWorkspaceOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  renameWorkspaceBusy || !renameWorkspaceValue.trim()
                }
              >
                {renameWorkspaceBusy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {discardOpen ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          body="You have unsaved edits in this document. Leave without saving?"
          confirmLabel="Discard"
          onCancel={() => {
            setDiscardOpen(false);
            setPendingHref(null);
          }}
          onConfirm={() => {
            void (async () => {
              const target = pendingHref;
              setDiscardOpen(false);
              setPendingHref(null);
              setEditorStatus((status) => ({ ...status, dirty: false }));

              if (!target) return;

              if (target.startsWith("__trash__:")) {
                const id = target.slice("__trash__:".length);
                setBusy(true);
                try {
                  await deleteDocument(id);
                  setActiveDocument(null);
                  toast({ tone: "success", title: "Moved to Trash" });
                  const { href } = closeTabAndPickNext(workspaceId, id, id);
                  queryClient.removeQueries({
                    queryKey: queryKeys.document(id),
                  });
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceDocuments(workspaceId),
                  });
                  setTabsRevision((value) => value + 1);
                  setRefreshKey((value) => value + 1);
                  if (href) router.push(href);
                } catch (error) {
                  toast({
                    tone: "error",
                    title: "Could not move file to Trash",
                    description: userFacingError(error, "Try again."),
                  });
                } finally {
                  setBusy(false);
                }
                return;
              }

              if (target.startsWith("__close__:")) {
                const documentId = target.slice("__close__:".length);
                const { href } = closeTabAndPickNext(
                  workspaceId,
                  documentId,
                  activeDocument?.id ?? null,
                );
                setTabsRevision((value) => value + 1);
                if (href) router.push(href);
                return;
              }

              router.push(target);
            })();
          }}
        />
      ) : null}
    </div>
  );
}

function ResizeHandle({
  side,
  onResize,
}: {
  side: "left" | "right";
  onResize: (deltaX: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize"
      className={cn(
        focusRingClass,
        "group relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/20",
      )}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 24 : 8;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(-step);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(step);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        let lastX = startX;

        function onMove(moveEvent: PointerEvent) {
          const delta = moveEvent.clientX - lastX;
          lastX = moveEvent.clientX;
          onResize(delta);
        }
        function onUp(upEvent: PointerEvent) {
          target.releasePointerCapture(upEvent.pointerId);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    >
      <div
        className={
          "absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-primary " +
          (side === "left" ? "right-0" : "left-0")
        }
      />
    </div>
  );
}

function WorkspaceHomeCanvas({
  onUpload,
  onSearch,
}: {
  onUpload: () => void;
  onSearch: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-sunken px-9">
      <div className="max-w-[440px] text-center">
        <div className="os-type-section mb-3">Workspace</div>
        <h2 className="mb-2 text-[length:var(--text-lg)] font-semibold tracking-[-0.03em] text-ink">
          Open a file to get started
        </h2>
        <p className="os-type-secondary mb-5 text-ink-soft">
          Drag Office files here, upload with ⌘O, or open from the explorer. The
          agent attaches once a file is open.
        </p>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={onUpload}
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-primary px-3 font-medium text-on-ink hover:bg-primary-hover",
            )}
          >
            Upload file
          </button>
          <button
            type="button"
            onClick={onSearch}
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 font-medium text-ink-soft hover:text-primary",
            )}
          >
            Quick Open
          </button>
        </div>
      </div>
    </div>
  );
}
