"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { DocumentHeader } from "@/components/documents/document-header";
import { DocumentNavigationPanel } from "@/components/documents/document-navigation-panel";
import {
  closeTabAndPickNext,
  DocumentOpenTabs,
} from "@/components/documents/document-open-tabs";
import { DocumentCanvas } from "@/components/documents/document-canvas";
import { DocumentAgentPanel } from "@/components/documents/document-agent-panel";
import {
  deleteDocument,
  downloadDocument,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import { userFacingError } from "@/components/files/format";
import { ConfirmDialog } from "@/components/ui/context-menu";
import {
  PANEL_LIMITS,
  readIdePanelPrefs,
  writeIdePanelPrefs,
} from "@/lib/ide-prefs";
import { uploadOfficeFiles } from "@/lib/office-upload";
import { useToast } from "@/lib/toast";
import { useCommandPalette } from "@/components/shell/command-palette";

/**
 * Cursor-like workspace IDE: explorer + tabs + canvas + agent.
 */
export function WorkspaceIde({
  workspaceId,
  workspaceName,
  document,
  documentPending = false,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
  documentPending?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
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
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [tabsRevision, setTabsRevision] = React.useState(0);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [draggingOver, setDraggingOver] = React.useState(false);
  const [uploadingDrop, setUploadingDrop] = React.useState(false);
  const dragDepth = React.useRef(0);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    setActiveDocument(document);
    setStarred(Boolean(document?.starred));
  }, [document]);

  React.useEffect(() => {
    writeIdePanelPrefs({
      explorerWidth,
      agentWidth,
      explorerCollapsed: navCollapsed,
      agentCollapsed,
    });
  }, [explorerWidth, agentWidth, navCollapsed, agentCollapsed]);

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

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "w") {
        if (!activeDocument) return;
        event.preventDefault();
        closeActiveTab();
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
  }, [activeDocument, closeActiveTab, workspaceId]);

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
    setBusy(true);
    setActionError(null);
    try {
      const id = activeDocument.id;
      await deleteDocument(id);
      setTrashOpen(false);
      toast({ tone: "success", title: "Moved to Trash" });
      const { href } = closeTabAndPickNext(workspaceId, id, id);
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
        workspaceId={workspaceId}
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
      />

      <div className="flex min-h-0 flex-1">
        <DocumentNavigationPanel
          workspaceId={workspaceId}
          activeDocumentId={activeDocument?.id ?? null}
          collapsed={navCollapsed}
          width={explorerWidth}
          refreshKey={refreshKey}
          onToggle={() => setNavCollapsed((value) => !value)}
          onDocumentRenamed={(updated) => {
            if (activeDocument?.id === updated.id) {
              setActiveDocument({ ...activeDocument, ...updated });
            }
            setTabsRevision((value) => value + 1);
          }}
          onDocumentTrashed={() => {
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
            revision={tabsRevision}
          />
          {activeDocument ? (
            <DocumentCanvas format={activeDocument.format} />
          ) : documentPending ? (
            <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-sunken">
              <p className="text-[12px] text-ink-faint">Opening file…</p>
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
          documentId={activeDocument?.id ?? null}
          documentName={activeDocument?.name}
          collapsed={agentCollapsed}
          width={agentWidth}
          onToggle={() => setAgentCollapsed((value) => !value)}
        />
      </div>

      {draggingOver || uploadingDrop ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[rgba(15,18,24,0.28)] backdrop-blur-[2px]">
          <div className="rounded-[16px] border border-dashed border-accent bg-surface px-8 py-7 text-center shadow-[0_20px_60px_rgba(15,18,24,0.18)]">
            <p className="text-[14px] font-semibold tracking-[-0.02em] text-ink">
              {uploadingDrop ? "Uploading…" : "Drop Office files to upload"}
            </p>
            <p className="mt-1 text-[11.5px] text-ink-soft">
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
          busy={busy}
          error={actionError}
          onCancel={() => setTrashOpen(false)}
          onConfirm={() => void handleTrash()}
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
      title="Drag to resize"
      className="group relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/25"
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
          "absolute inset-y-0 w-px bg-transparent group-hover:bg-accent/40 " +
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
        <div className="mb-3 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Workspace
        </div>
        <h2 className="mb-2 text-[18px] font-semibold tracking-[-0.03em] text-ink">
          Open a file to get started
        </h2>
        <p className="mb-5 text-[12px] leading-relaxed text-ink-soft">
          Drag Office files here, upload with ⌘O, or open from the explorer. The
          agent attaches once a file is open.
        </p>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={onUpload}
            className="inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-ink px-3 text-[11.5px] font-medium text-white hover:bg-[#2A2D33]"
          >
            Upload file
          </button>
          <button
            type="button"
            onClick={onSearch}
            className="inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[11.5px] font-medium text-ink-soft hover:text-ink"
          >
            Quick Open
          </button>
        </div>
      </div>
    </div>
  );
}
