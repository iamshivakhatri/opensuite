"use client";

import * as React from "react";
import Link from "next/link";

import { FileRow } from "@/components/files/file-row";
import { userFacingError } from "@/components/files/format";
import { UploadDocumentButton } from "@/components/files/upload-document-button";
import {
  CreateWorkspaceEmptyState,
  readStoredWorkspaceId,
  storeWorkspaceId,
  WorkspaceSelector,
} from "@/components/files/workspace-selector";
import { Button } from "@/components/ui/button";
import {
  createWorkspace,
  listDocuments,
  listWorkspaces,
  uploadDocument,
  type ListedDocument,
  type Workspace,
} from "@/lib/api";

type Phase =
  | { kind: "boot" }
  | { kind: "workspaces_error"; message: string }
  | { kind: "no_workspace" }
  | {
      kind: "ready";
      workspaces: Workspace[];
      workspaceId: string;
      documents: ListedDocument[];
      documentsStatus: "loading" | "ready" | "error";
      documentsError: string | null;
    };

/**
 * First real All Files surface: workspace load/create, document list,
 * Office upload, and proxied download.
 */
export function FilesView() {
  const [phase, setPhase] = React.useState<Phase>({ kind: "boot" });
  const [creatingWorkspace, setCreatingWorkspace] = React.useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = React.useState<
    string | null
  >(null);
  const [uploading, setUploading] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const loadWorkspaces = React.useCallback(async () => {
    setPhase({ kind: "boot" });
    setCreateWorkspaceError(null);
    setActionError(null);
    try {
      const workspaces = await listWorkspaces();
      if (workspaces.length === 0) {
        setPhase({ kind: "no_workspace" });
        return;
      }

      const stored = readStoredWorkspaceId();
      const selected =
        workspaces.find((workspace) => workspace.id === stored) ??
        workspaces[0]!;
      storeWorkspaceId(selected.id);
      setPhase({
        kind: "ready",
        workspaces,
        workspaceId: selected.id,
        documents: [],
        documentsStatus: "loading",
        documentsError: null,
      });
    } catch (error) {
      setPhase({
        kind: "workspaces_error",
        message: userFacingError(error, "Could not load workspaces."),
      });
    }
  }, []);

  React.useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  React.useEffect(() => {
    if (phase.kind !== "ready" || phase.documentsStatus !== "loading") {
      return;
    }

    const workspaceId = phase.workspaceId;
    let cancelled = false;

    listDocuments(workspaceId)
      .then((documents) => {
        if (cancelled) return;
        setPhase((current) =>
          current.kind === "ready" && current.workspaceId === workspaceId
            ? {
                ...current,
                documents,
                documentsStatus: "ready",
                documentsError: null,
              }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase((current) =>
          current.kind === "ready" && current.workspaceId === workspaceId
            ? {
                ...current,
                documentsStatus: "error",
                documentsError: userFacingError(
                  error,
                  "Could not load documents.",
                ),
              }
            : current,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    phase.kind,
    phase.kind === "ready" ? phase.workspaceId : null,
    phase.kind === "ready" ? phase.documentsStatus : null,
  ]);

  async function handleCreateWorkspace(name: string) {
    setCreatingWorkspace(true);
    setCreateWorkspaceError(null);
    try {
      const workspace = await createWorkspace(name);
      storeWorkspaceId(workspace.id);
      setPhase({
        kind: "ready",
        workspaces: [workspace],
        workspaceId: workspace.id,
        documents: [],
        documentsStatus: "loading",
        documentsError: null,
      });
    } catch (error) {
      setCreateWorkspaceError(
        userFacingError(error, "Could not create workspace."),
      );
    } finally {
      setCreatingWorkspace(false);
    }
  }

  function selectWorkspace(workspaceId: string) {
    if (phase.kind !== "ready") return;
    storeWorkspaceId(workspaceId);
    setActionError(null);
    setPhase({
      ...phase,
      workspaceId,
      documents: [],
      documentsStatus: "loading",
      documentsError: null,
    });
  }

  function retryDocuments() {
    if (phase.kind !== "ready") return;
    setPhase({
      ...phase,
      documentsStatus: "loading",
      documentsError: null,
    });
  }

  async function handleUpload(file: File) {
    if (phase.kind !== "ready" || uploading) return;
    setUploading(true);
    setActionError(null);
    try {
      const { document } = await uploadDocument(phase.workspaceId, file);
      setPhase((current) => {
        if (current.kind !== "ready") return current;
        const without = current.documents.filter((item) => item.id !== document.id);
        return {
          ...current,
          documents: [document, ...without],
          documentsStatus: "ready",
          documentsError: null,
        };
      });
    } catch (error) {
      setActionError(userFacingError(error, "Could not upload this file."));
    } finally {
      setUploading(false);
    }
  }

  if (phase.kind === "boot") {
    return (
      <div className="grid h-full place-items-center text-[13px] text-ink-soft">
        Loading files…
      </div>
    );
  }

  if (phase.kind === "workspaces_error") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <p className="mb-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {phase.message}
        </p>
        <Button type="button" onClick={() => void loadWorkspaces()}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase.kind === "no_workspace") {
    return (
      <CreateWorkspaceEmptyState
        creating={creatingWorkspace}
        error={createWorkspaceError}
        onCreate={(name) => void handleCreateWorkspace(name)}
      />
    );
  }

  const activeWorkspace = phase.workspaces.find(
    (workspace) => workspace.id === phase.workspaceId,
  );
  const showEmpty =
    phase.documentsStatus === "ready" && phase.documents.length === 0;

  return (
    <div className="mx-auto max-w-[1080px] px-12 pb-[90px] pt-11 max-[900px]:px-5">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.09em] text-[#686AE3]">
            OpenSuite Workspace
          </div>
          <h1 className="mb-2 text-[32px] font-semibold leading-[1.12] tracking-[-0.045em] text-ink">
            All Files
          </h1>
          <p className="max-w-[620px] text-[12.5px] leading-relaxed text-[#777D87]">
            Open the workspace like a project folder, or open a single file.
            Upload Word, PowerPoint, or Excel into{" "}
            {activeWorkspace?.name ?? "your workspace"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WorkspaceSelector
            workspaces={phase.workspaces}
            activeId={phase.workspaceId}
            onChange={selectWorkspace}
          />
          <Link
            href={`/app/workspaces/${phase.workspaceId}`}
            className="inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-ink px-3.5 text-[12px] font-medium text-white hover:bg-[#2A2D33]"
          >
            Open workspace
          </Link>
          <UploadDocumentButton
            uploading={uploading}
            disabled={phase.documentsStatus === "loading"}
            onFileSelected={(file) => void handleUpload(file)}
          />
        </div>
      </div>

      {actionError ? (
        <p className="mb-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {actionError}
        </p>
      ) : null}

      {phase.documentsStatus === "loading" ? (
        <div className="rounded-[14px] border border-line bg-white px-4 py-10 text-center text-[12px] text-ink-soft">
          Loading documents…
        </div>
      ) : phase.documentsStatus === "error" ? (
        <div className="rounded-[14px] border border-line bg-white px-4 py-10 text-center">
          <p className="mb-4 text-[12px] text-danger">
            {phase.documentsError ?? "Could not load documents."}
          </p>
          <Button type="button" size="sm" onClick={retryDocuments}>
            Try again
          </Button>
        </div>
      ) : showEmpty ? (
        <div className="mx-auto max-w-[480px] py-16 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-[12px] bg-sunken text-ink-faint">
            ▦
          </div>
          <h2 className="mb-2 text-[22px] font-semibold tracking-[-0.03em] text-ink">
            No files yet
          </h2>
          <p className="mb-6 text-[12px] leading-relaxed text-ink-soft">
            Upload a Word, PowerPoint, or Excel document, or open the empty
            workspace and add files later.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link
              href={`/app/workspaces/${phase.workspaceId}`}
              className="inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-ink px-3.5 text-[12px] font-medium text-white hover:bg-[#2A2D33]"
            >
              Open workspace
            </Link>
            <UploadDocumentButton
              uploading={uploading}
              onFileSelected={(file) => void handleUpload(file)}
            />
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-2.5 flex items-center justify-between px-0.5">
            <h3 className="text-[11.5px] font-semibold text-[#40444D]">
              Workspace files
            </h3>
            <span className="text-[9.5px] text-[#9AA0AA]">
              {phase.documents.length}{" "}
              {phase.documents.length === 1 ? "item" : "items"}
            </span>
          </div>
          <div className="overflow-hidden rounded-[14px] border border-[#E4E7EC] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.025)]">
            <div className="grid grid-cols-[minmax(200px,1.5fr)_80px_120px_90px_80px] gap-2 border-b border-[#ECEEF1] px-3.5 py-2.5 text-[9.5px] font-medium uppercase tracking-[0.04em] text-[#9AA0AA] max-[900px]:grid-cols-[1fr_88px] max-[900px]:[&>*:nth-child(n+2):nth-child(-n+4)]:hidden">
              <div>Name</div>
              <div>Type</div>
              <div>Updated</div>
              <div>Size</div>
              <div className="text-right">Action</div>
            </div>
            {phase.documents.map((document) => (
              <FileRow
                key={document.id}
                document={document}
                onError={(message) => setActionError(message || null)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
