"use client";

import * as React from "react";

import { DocumentHeader } from "@/components/documents/document-header";
import { DocumentNavigationPanel } from "@/components/documents/document-navigation-panel";
import {
  DocumentOpenTabs,
  removeStoredTab,
  writeStoredTabs,
  readStoredTabs,
} from "@/components/documents/document-open-tabs";
import { DocumentCanvas } from "@/components/documents/document-canvas";
import { DocumentAgentPanel } from "@/components/documents/document-agent-panel";
import {
  deleteDocument,
  downloadDocument,
  renameDocument,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import { userFacingError } from "@/components/files/format";
import {
  ConfirmDialog,
  PromptDialog,
} from "@/components/ui/context-menu";
import { useRouter } from "next/navigation";
import { documentPath, workspacePath } from "@/lib/paths";

/**
 * Cursor-like workspace IDE: explorer + tabs + canvas + agent.
 * Works with zero open files (workspace home) or an active document.
 */
export function WorkspaceIde({
  workspaceId,
  workspaceName,
  document,
}: {
  workspaceId: string;
  workspaceName?: string | null;
  document: ListedDocument | null;
}) {
  const router = useRouter();
  const [navCollapsed, setNavCollapsed] = React.useState(false);
  const [agentCollapsed, setAgentCollapsed] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [activeDocument, setActiveDocument] =
    React.useState<ListedDocument | null>(document);
  const [starred, setStarred] = React.useState(Boolean(document?.starred));
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [tabEpoch, setTabEpoch] = React.useState(0);

  React.useEffect(() => {
    setActiveDocument(document);
    setStarred(Boolean(document?.starred));
  }, [document]);

  async function handleDownload() {
    if (!activeDocument || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadDocument(activeDocument.id);
    } catch (error) {
      setDownloadError(
        userFacingError(error, "Could not download this file."),
      );
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
    } catch {
      setStarred(!next);
    }
  }

  async function handleRename(name: string) {
    if (!activeDocument || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await renameDocument(activeDocument.id, name);
      setActiveDocument({ ...activeDocument, ...updated });
      const tabs = readStoredTabs(workspaceId).map((tab) =>
        tab.id === updated.id
          ? { ...tab, name: updated.name, format: updated.format }
          : tab,
      );
      writeStoredTabs(workspaceId, tabs);
      setTabEpoch((value) => value + 1);
      setRenameOpen(false);
    } catch (error) {
      setActionError(userFacingError(error, "Could not rename file."));
    } finally {
      setBusy(false);
    }
  }

  function navigateAfterTrash(trashedId: string) {
    removeStoredTab(workspaceId, trashedId);
    setTabEpoch((value) => value + 1);
    const remaining = readStoredTabs(workspaceId);
    const fallback = remaining[remaining.length - 1];
    if (fallback) {
      router.push(documentPath(workspaceId, fallback.id));
    } else {
      router.push(workspacePath(workspaceId));
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
      navigateAfterTrash(id);
    } catch (error) {
      setActionError(userFacingError(error, "Could not move file to Trash."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <DocumentHeader
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        document={activeDocument}
        downloading={downloading}
        onDownload={activeDocument ? () => void handleDownload() : undefined}
        starred={starred}
        onToggleStar={activeDocument ? () => void handleToggleStar() : undefined}
        onRename={
          activeDocument
            ? () => {
                setActionError(null);
                setRenameOpen(true);
              }
            : undefined
        }
        onTrash={
          activeDocument
            ? () => {
                setActionError(null);
                setTrashOpen(true);
              }
            : undefined
        }
      />

      {downloadError ? (
        <p className="mx-3.5 mt-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {downloadError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <DocumentNavigationPanel
          workspaceId={workspaceId}
          activeDocumentId={activeDocument?.id ?? null}
          collapsed={navCollapsed}
          onToggle={() => setNavCollapsed((value) => !value)}
          onDocumentRenamed={(updated) => {
            if (activeDocument?.id === updated.id) {
              setActiveDocument({ ...activeDocument, ...updated });
            }
            setTabEpoch((value) => value + 1);
          }}
          onDocumentTrashed={(documentId) => {
            if (activeDocument?.id === documentId) {
              // Navigation handled by explorer.
              return;
            }
            setTabEpoch((value) => value + 1);
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DocumentOpenTabs
            key={tabEpoch}
            workspaceId={workspaceId}
            activeDocument={activeDocument}
          />
          {activeDocument ? (
            <DocumentCanvas format={activeDocument.format} />
          ) : (
            <WorkspaceHomeCanvas />
          )}
        </div>
        <DocumentAgentPanel
          documentId={activeDocument?.id ?? null}
          documentName={activeDocument?.name}
          collapsed={agentCollapsed}
          onToggle={() => setAgentCollapsed((value) => !value)}
        />
      </div>

      {renameOpen && activeDocument ? (
        <PromptDialog
          title="Rename file"
          initialValue={activeDocument.name}
          busy={busy}
          error={actionError}
          onCancel={() => setRenameOpen(false)}
          onSubmit={(name) => void handleRename(name)}
        />
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

function WorkspaceHomeCanvas() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-sunken px-9">
      <div className="max-w-[420px] text-center">
        <div className="mb-3 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Workspace
        </div>
        <h2 className="mb-2 text-[18px] font-semibold tracking-[-0.03em] text-ink">
          Open a file to get started
        </h2>
        <p className="text-[12px] leading-relaxed text-ink-soft">
          Use the explorer or ＋ to open Word, PowerPoint, or Excel files in this
          workspace. The agent attaches once a file is open — workspace-wide
          agent chat is not available yet.
        </p>
      </div>
    </div>
  );
}
