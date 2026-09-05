"use client";

import * as React from "react";

import { DocumentHeader } from "@/components/documents/document-header";
import { DocumentNavigationPanel } from "@/components/documents/document-navigation-panel";
import { DocumentOpenTabs } from "@/components/documents/document-open-tabs";
import { DocumentCanvas } from "@/components/documents/document-canvas";
import { DocumentAgentPanel } from "@/components/documents/document-agent-panel";
import {
  downloadDocument,
  setDocumentStarred,
  type ListedDocument,
} from "@/lib/api";
import { userFacingError } from "@/components/files/format";

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
  const [navCollapsed, setNavCollapsed] = React.useState(false);
  const [agentCollapsed, setAgentCollapsed] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [starred, setStarred] = React.useState(Boolean(document?.starred));

  React.useEffect(() => {
    setStarred(Boolean(document?.starred));
  }, [document?.id, document?.starred]);

  async function handleDownload() {
    if (!document || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadDocument(document.id);
    } catch (error) {
      setDownloadError(
        userFacingError(error, "Could not download this file."),
      );
    } finally {
      setDownloading(false);
    }
  }

  async function handleToggleStar() {
    if (!document) return;
    const next = !starred;
    setStarred(next);
    try {
      await setDocumentStarred(document.id, next);
    } catch {
      setStarred(!next);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <DocumentHeader
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        document={document}
        downloading={downloading}
        onDownload={document ? () => void handleDownload() : undefined}
        starred={starred}
        onToggleStar={document ? () => void handleToggleStar() : undefined}
      />

      {downloadError ? (
        <p className="mx-3.5 mt-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {downloadError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <DocumentNavigationPanel
          workspaceId={workspaceId}
          activeDocumentId={document?.id ?? null}
          collapsed={navCollapsed}
          onToggle={() => setNavCollapsed((value) => !value)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DocumentOpenTabs
            workspaceId={workspaceId}
            activeDocument={document}
          />
          {document ? (
            <DocumentCanvas format={document.format} />
          ) : (
            <WorkspaceHomeCanvas />
          )}
        </div>
        <DocumentAgentPanel
          documentId={document?.id ?? null}
          documentName={document?.name}
          collapsed={agentCollapsed}
          onToggle={() => setAgentCollapsed((value) => !value)}
        />
      </div>
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
