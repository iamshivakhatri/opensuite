"use client";

import * as React from "react";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import {
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/context-menu";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import {
  listTrash,
  restoreDocument,
  restoreWorkspace,
  type TrashedDocument,
  type TrashedWorkspace,
} from "@/lib/api";
import { purgeTrashedDocument } from "@/lib/storage-api";
import {
  notifyStorageChanged,
  permanentDeleteConfirmBody,
  trashDocumentActions,
  trashWorkspaceActions,
} from "@/lib/storage-model";
import { useToast } from "@/lib/toast";

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      className={className}
      aria-hidden
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function TrashView() {
  const { toast } = useToast();
  const [workspaces, setWorkspaces] = React.useState<TrashedWorkspace[] | null>(
    null,
  );
  const [documents, setDocuments] = React.useState<TrashedDocument[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = React.useState<TrashedDocument | null>(
    null,
  );
  const [purgeBusy, setPurgeBusy] = React.useState(false);
  const [purgeError, setPurgeError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const trash = await listTrash();
      setWorkspaces(trash.workspaces);
      setDocuments(trash.documents);
    } catch (err) {
      setError(userFacingError(err, "Could not load trash."));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleRestoreWorkspace(item: TrashedWorkspace) {
    if (busyId) return;
    setBusyId(item.id);
    setActionError(null);
    try {
      await restoreWorkspace(item.id);
      await load();
      toast({ tone: "success", title: "Workspace restored" });
    } catch (err) {
      const message = userFacingError(err, "Could not restore workspace.");
      setActionError(message);
      toast({ tone: "error", title: "Restore failed", description: message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestoreDocument(item: TrashedDocument) {
    if (busyId) return;
    setBusyId(item.id);
    setActionError(null);
    try {
      await restoreDocument(item.id);
      await load();
      toast({ tone: "success", title: "File restored" });
    } catch (err) {
      const message = userFacingError(err, "Could not restore document.");
      setActionError(message);
      toast({ tone: "error", title: "Restore failed", description: message });
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurgeConfirm() {
    if (!purgeTarget || purgeBusy) return;
    setPurgeBusy(true);
    setPurgeError(null);
    const documentId = purgeTarget.id;
    try {
      await purgeTrashedDocument(documentId);
      setDocuments((current) =>
        (current ?? []).filter((row) => row.id !== documentId),
      );
      setPurgeTarget(null);
      notifyStorageChanged();
      toast({ tone: "success", title: "Document permanently deleted" });
    } catch (err) {
      const message = userFacingError(
        err,
        "Could not permanently delete document.",
      );
      setPurgeError(message);
      toast({
        tone: "error",
        title: "Permanent delete failed",
        description: message,
      });
    } finally {
      setPurgeBusy(false);
    }
  }

  const empty =
    workspaces !== null &&
    documents !== null &&
    workspaces.length === 0 &&
    documents.length === 0;

  const workspaceActions = trashWorkspaceActions();

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6">
        <div className="os-type-section mb-1 flex items-center gap-2">
          <TrashIcon className="h-3 w-3" />
          Library
        </div>
        <h1 className="flex items-center gap-2 text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
          <TrashIcon className="h-[18px] w-[18px] text-ink-soft" />
          Trash
        </h1>
        <p className="os-type-secondary mt-1 text-ink-soft">
          Soft-deleted workspaces and documents. Restore items, or permanently
          delete documents to free storage.
        </p>
      </div>

      {error ? (
        <div className="mb-4">
          <PageError message={error} onRetry={() => void load()} />
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <PageError message={actionError} />
        </div>
      ) : null}

      {workspaces === null && !error ? (
        <PageLoading />
      ) : null}

      {empty ? (
        <PageEmpty
          title="Trash is empty"
          description="Items you move to trash will appear here."
        />
      ) : null}

      {(workspaces?.length ?? 0) > 0 ? (
        <section className="mb-8">
          <h2 className="os-type-section mb-2">Workspaces</h2>
          <div className="flex flex-col gap-1.5">
            {workspaces!.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] text-ink-faint">
                  <TrashIcon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="os-type-label truncate font-medium text-ink">
                    {item.name}
                  </div>
                  <div className="os-type-meta text-ink-faint">
                    Workspace · Deleted {formatUpdatedAt(item.deletedAt)}
                  </div>
                </div>
                {workspaceActions.canRestore ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyId === item.id}
                    onClick={() => void handleRestoreWorkspace(item)}
                  >
                    {busyId === item.id ? "Restoring…" : "Restore"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {(documents?.length ?? 0) > 0 ? (
        <section>
          <h2 className="os-type-section mb-2">Documents</h2>
          <div className="flex flex-col gap-1.5">
            {documents!.map((item) => {
              const actions = trashDocumentActions({
                workspaceDeleted: item.workspaceDeleted,
              });
              const rowBusy = busyId === item.id;
              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5"
                >
                  <span className="relative shrink-0">
                    <DocumentFormatIcon
                      format={item.format}
                      size="md"
                      className="text-ink-soft"
                    />
                    <span className="absolute -right-1.5 -top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-danger-soft text-danger">
                      <TrashIcon className="h-2 w-2" />
                    </span>
                  </span>
                  <div className="min-w-0 flex-1 basis-[12rem]">
                    <div className="os-type-label truncate font-medium text-ink">
                      {item.name}
                    </div>
                    <div className="os-type-meta truncate text-ink-faint">
                      {item.workspaceName}
                      {item.workspaceDeleted ? " (workspace in trash)" : ""}
                      {" · "}
                      Deleted {formatUpdatedAt(item.deletedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rowBusy || !actions.canRestore}
                      title={actions.restoreBlockedReason ?? "Restore"}
                      onClick={() => void handleRestoreDocument(item)}
                    >
                      {rowBusy ? "Restoring…" : "Restore"}
                    </Button>
                    {actions.canPermanentlyDelete ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-danger-soft hover:text-danger"
                        disabled={rowBusy || purgeBusy}
                        onClick={() => {
                          setPurgeError(null);
                          setPurgeTarget(item);
                        }}
                      >
                        Delete forever
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {purgeTarget ? (
        <ConfirmDialog
          title="Delete forever?"
          body={permanentDeleteConfirmBody(purgeTarget.name)}
          confirmLabel="Delete forever"
          busy={purgeBusy}
          error={purgeError}
          onCancel={() => {
            if (purgeBusy) return;
            setPurgeTarget(null);
            setPurgeError(null);
          }}
          onConfirm={() => void handlePurgeConfirm()}
        />
      ) : null}
    </div>
  );
}
