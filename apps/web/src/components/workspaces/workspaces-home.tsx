"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import { formatLabel, formatUpdatedAt, userFacingError } from "@/components/files/format";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  type Workspace,
} from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import { useToast } from "@/lib/toast";

/**
 * /app home — workspace cards, not an implicit file library.
 */
export function WorkspacesHome() {
  const router = useRouter();
  const { toast } = useToast();
  const [workspaces, setWorkspaces] = React.useState<Workspace[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [menuId, setMenuId] = React.useState<string | null>(null);
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<Workspace | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      setWorkspaces(await listWorkspaces());
    } catch (err) {
      setError(userFacingError(err, "Could not load workspaces."));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuId(null);
        setRenameId(null);
        setDeleteTarget(null);
      }
    }
    function onClick() {
      setMenuId(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(name);
      setName("");
      toast({ tone: "success", title: "Workspace created" });
      router.push(workspacePath(workspace.id));
    } catch (err) {
      setCreateError(userFacingError(err, "Could not create workspace."));
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(event: React.FormEvent) {
    event.preventDefault();
    if (!renameId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await renameWorkspace(renameId, renameValue);
      setRenameId(null);
      await load();
      toast({ tone: "success", title: "Workspace renamed" });
    } catch (err) {
      setActionError(userFacingError(err, "Could not rename workspace."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteWorkspace(deleteTarget.id);
      setDeleteTarget(null);
      await load();
      toast({ tone: "success", title: "Moved to Trash" });
    } catch (err) {
      setActionError(userFacingError(err, "Could not delete workspace."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="mb-1 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
            OpenSuite
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">
            Workspaces
          </h1>
          <p className="mt-1 text-[12px] text-ink-soft">
            Open a workspace to browse files and work with the agent.
          </p>
        </div>
      </div>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="mb-6 flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface px-3 py-3"
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New workspace name"
          className="min-w-[220px] flex-1"
          maxLength={100}
        />
        <Button type="submit" size="sm" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create workspace"}
        </Button>
        {createError ? (
          <p className="w-full text-[11px] text-danger">{createError}</p>
        ) : null}
      </form>

      {error ? (
        <div className="mb-4">
          <PageError message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {workspaces === null && !error ? (
        <PageLoading label="Loading workspaces…" />
      ) : null}

      {workspaces !== null && workspaces.length === 0 ? (
        <PageEmpty
          title="Create your first workspace"
          description="Workspaces hold your Word, PowerPoint, and Excel files."
        />
      ) : null}

      <div className="flex flex-col gap-2">
        {(workspaces ?? []).map((workspace) => (
          <div
            key={workspace.id}
            className="group relative rounded-[14px] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-[#D5D9E0]"
          >
            <Link
              href={workspacePath(workspace.id)}
              className="block min-w-0 pr-10"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate text-[13.5px] font-semibold tracking-[-0.02em] text-ink">
                  {workspace.name}
                </span>
                <span className="shrink-0 text-[10.5px] text-ink-faint">
                  {workspace.documentCount}{" "}
                  {workspace.documentCount === 1 ? "file" : "files"}
                </span>
              </div>
              <div className="mb-2 text-[11px] text-ink-faint">
                Updated {formatUpdatedAt(workspace.updatedAt)}
              </div>
              {workspace.recentDocuments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {workspace.recentDocuments.map((doc) => (
                    <span
                      key={doc.id}
                      className="inline-flex max-w-[180px] items-center gap-1.5 rounded-full border border-line bg-[var(--paper)] px-2 py-0.5 text-[10px] text-ink-soft"
                      onClick={(event) => {
                        event.preventDefault();
                        router.push(documentPath(workspace.id, doc.id));
                      }}
                    >
                      <span className="font-mono text-[7.5px] uppercase text-ink-faint">
                        {formatLabel(doc.format)}
                      </span>
                      <span className="truncate">{doc.name}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-ink-faint">No files yet</p>
              )}
            </Link>
            <button
              type="button"
              title="Workspace actions"
              className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint opacity-0 hover:bg-sunken hover:text-ink group-hover:opacity-100"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenuId((current) =>
                  current === workspace.id ? null : workspace.id,
                );
              }}
            >
              ···
            </button>
            {menuId === workspace.id ? (
              <div
                className="absolute right-3 top-11 z-10 min-w-[140px] overflow-hidden rounded-[10px] border border-line bg-surface py-1 shadow-[0_8px_28px_rgba(15,18,24,0.12)]"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-sunken"
                  onClick={() => {
                    setMenuId(null);
                    setRenameId(workspace.id);
                    setRenameValue(workspace.name);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[11.5px] text-danger hover:bg-danger-soft"
                  onClick={() => {
                    setMenuId(null);
                    setDeleteTarget(workspace);
                  }}
                >
                  Move to Trash
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {renameId ? (
        <Dialog title="Rename workspace" onClose={() => setRenameId(null)}>
          <form onSubmit={(event) => void handleRename(event)} className="space-y-3">
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={100}
            />
            {actionError ? (
              <p className="text-[11px] text-danger">{actionError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setRenameId(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !renameValue.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog title="Move workspace to Trash?" onClose={() => setDeleteTarget(null)}>
          <p className="mb-4 text-[12px] leading-relaxed text-ink-soft">
            Move <span className="font-medium text-ink">{deleteTarget.name}</span>{" "}
            to Trash. Files remain recoverable from Trash.
          </p>
          {actionError ? (
            <p className="mb-3 text-[11px] text-danger">{actionError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="bg-danger hover:bg-[#B0453A]"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? "Moving…" : "Move to Trash"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,18,24,0.32)] px-4 backdrop-blur-[6px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[380px] rounded-[16px] border border-line bg-surface p-4 shadow-[0_24px_80px_rgba(15,18,24,0.2)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-[14px] font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
