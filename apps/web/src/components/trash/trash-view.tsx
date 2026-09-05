"use client";

import * as React from "react";

import {
  formatLabel,
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import { Button } from "@/components/ui/button";
import {
  listTrash,
  restoreDocument,
  restoreWorkspace,
  type TrashedDocument,
  type TrashedWorkspace,
} from "@/lib/api";

export function TrashView() {
  const [workspaces, setWorkspaces] = React.useState<TrashedWorkspace[] | null>(
    null,
  );
  const [documents, setDocuments] = React.useState<TrashedDocument[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

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
    } catch (err) {
      setActionError(userFacingError(err, "Could not restore workspace."));
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
    } catch (err) {
      setActionError(userFacingError(err, "Could not restore document."));
    } finally {
      setBusyId(null);
    }
  }

  const empty =
    workspaces !== null &&
    documents !== null &&
    workspaces.length === 0 &&
    documents.length === 0;

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6">
        <div className="mb-1 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Library
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">
          Trash
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          Soft-deleted workspaces and documents. Restore only — permanent
          delete is not available yet.
        </p>
      </div>

      {error ? (
        <div className="mb-4 rounded-[12px] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
          <button type="button" className="ml-2 underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4 rounded-[12px] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {actionError}
        </div>
      ) : null}

      {workspaces === null && !error ? (
        <p className="text-[12px] text-ink-faint">Loading…</p>
      ) : null}

      {empty ? (
        <div className="rounded-[16px] border border-dashed border-line px-6 py-14 text-center">
          <p className="text-[13px] font-medium text-ink">Trash is empty</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            Items you move to trash will appear here.
          </p>
        </div>
      ) : null}

      {(workspaces?.length ?? 0) > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Workspaces
          </h2>
          <div className="flex flex-col gap-1.5">
            {workspaces!.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-3 py-2.5"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] text-[10px] text-ink-soft">
                  WS
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-ink">
                    {item.name}
                  </div>
                  <div className="text-[10.5px] text-ink-faint">
                    Workspace · Deleted {formatUpdatedAt(item.deletedAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyId === item.id}
                  onClick={() => void handleRestoreWorkspace(item)}
                >
                  {busyId === item.id ? "Restoring…" : "Restore"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {(documents?.length ?? 0) > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Documents
          </h2>
          <div className="flex flex-col gap-1.5">
            {documents!.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-3 py-2.5"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] font-mono text-[7.5px] text-ink-soft">
                  {formatLabel(item.format)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-ink">
                    {item.name}
                  </div>
                  <div className="truncate text-[10.5px] text-ink-faint">
                    {item.workspaceName}
                    {item.workspaceDeleted ? " (workspace in trash)" : ""}
                    {" · "}
                    Deleted {formatUpdatedAt(item.deletedAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyId === item.id || item.workspaceDeleted}
                  title={
                    item.workspaceDeleted
                      ? "Restore the workspace first"
                      : "Restore"
                  }
                  onClick={() => void handleRestoreDocument(item)}
                >
                  {busyId === item.id ? "Restoring…" : "Restore"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
