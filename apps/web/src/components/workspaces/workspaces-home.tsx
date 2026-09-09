"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import {
  formatLabel,
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  type Workspace,
} from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import {
  filterOfficeUploadFiles,
  isOfficeUploadFile,
  uploadOfficeFiles,
} from "@/lib/office-upload";
import { useToast } from "@/lib/toast";

/**
 * /app home — workspaces + direct upload into existing or new workspace.
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
  const [pendingFiles, setPendingFiles] = React.useState<File[] | null>(null);
  const [draggingOver, setDraggingOver] = React.useState(false);
  const dragDepth = React.useRef(0);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const menuAnchorRefs = React.useRef<Map<string, HTMLButtonElement>>(
    new Map(),
  );

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

  const menuWorkspace =
    (workspaces ?? []).find((workspace) => workspace.id === menuId) ?? null;

  function takeOfficeFiles(files: FileList | File[] | null) {
    if (!files) return;
    const accepted = filterOfficeUploadFiles(files);
    const rejected = Array.from(files).filter((file) => !isOfficeUploadFile(file));
    if (rejected.length > 0) {
      toast({
        tone: "error",
        title: "Unsupported format",
        description: "Only .docx, .pptx, and .xlsx are supported.",
      });
    }
    if (accepted.length === 0) return;
    setPendingFiles(accepted);
  }

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
            Open a workspace, or upload files into a new or existing one.
          </p>
        </div>
      </div>

      <div
        className={
          "mb-5 rounded-[var(--radius-md)] border border-dashed px-5 py-7 text-center transition-colors " +
          (draggingOver
            ? "border-accent bg-accent-soft/40"
            : "border-line bg-surface")
        }
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDraggingOver(false);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDraggingOver(false);
          takeOfficeFiles(event.dataTransfer.files);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".docx,.pptx,.xlsx"
          multiple
          className="hidden"
          onChange={(event) => {
            takeOfficeFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <p className="text-[13px] font-semibold tracking-[-0.01em] text-ink">
          {draggingOver ? "Drop to upload" : "Drop Office files here"}
        </p>
        <p className="mt-1 text-[11.5px] text-ink-soft">
          .docx · .pptx · .xlsx — then choose an existing workspace or create one
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => fileRef.current?.click()}
        >
          Choose files
        </Button>
      </div>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="mb-6 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-3"
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Or create an empty workspace…"
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
        <PageLoading variant="workspaces" />
      ) : null}

      {workspaces !== null && workspaces.length === 0 ? (
        <PageEmpty
          title="Create your first workspace"
          description="Drop a file above to create a workspace around it, or name one here."
        />
      ) : null}

      <div className="flex flex-col gap-2">
        {(workspaces ?? []).map((workspace) => (
          <div
            key={workspace.id}
            className="group relative rounded-[var(--radius-md)] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-ink-faint"
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
            </Link>
            {workspace.recentDocuments.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {workspace.recentDocuments.map((doc) => (
                  <Link
                    key={doc.id}
                    href={documentPath(workspace.id, doc.id)}
                    className={
                  "inline-flex max-w-[200px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-[var(--paper)] px-2 py-0.5 text-[10px] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
                }
                prefetch
                  >
                    <span className="font-mono text-[7.5px] uppercase text-ink-faint">
                      {formatLabel(doc.format)}
                    </span>
                    <span className="truncate">{doc.name}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-ink-faint">No files yet</p>
            )}
            <button
              type="button"
              title="Workspace actions"
              ref={(node) => {
                if (node) menuAnchorRefs.current.set(workspace.id, node);
                else menuAnchorRefs.current.delete(workspace.id);
              }}
              className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[12px] text-ink-faint opacity-0 hover:bg-sunken hover:text-ink group-hover:opacity-100"
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
          </div>
        ))}
      </div>

      {menuWorkspace ? (
        <ContextMenu
          open={menuId === menuWorkspace.id}
          onClose={() => setMenuId(null)}
          anchorRef={{
            current: menuAnchorRefs.current.get(menuWorkspace.id) ?? null,
          }}
          items={[
            {
              id: "rename",
              label: "Rename",
              onSelect: () => {
                setRenameId(menuWorkspace.id);
                setRenameValue(menuWorkspace.name);
                setActionError(null);
              },
            },
            {
              id: "trash",
              label: "Move to Trash",
              danger: true,
              onSelect: () => {
                setDeleteTarget(menuWorkspace);
                setActionError(null);
              },
            },
          ]}
        />
      ) : null}

      {pendingFiles ? (
        <UploadDestinationDialog
          files={pendingFiles}
          workspaces={workspaces ?? []}
          onClose={() => setPendingFiles(null)}
          onUploaded={async (workspaceId, documentId) => {
            setPendingFiles(null);
            await load();
            toast({ tone: "success", title: "File uploaded" });
            router.push(documentPath(workspaceId, documentId));
          }}
          onError={(message) =>
            toast({ tone: "error", title: "Upload failed", description: message })
          }
        />
      ) : null}

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
              className="bg-danger text-on-ink hover:opacity-90"
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

function UploadDestinationDialog({
  files,
  workspaces,
  onClose,
  onUploaded,
  onError,
}: {
  files: File[];
  workspaces: Workspace[];
  onClose: () => void;
  onUploaded: (workspaceId: string, documentId: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const defaultName =
    files[0]?.name.replace(/\.(docx|pptx|xlsx)$/i, "").trim() || "New workspace";
  const [mode, setMode] = React.useState<"existing" | "new">(
    workspaces.length > 0 ? "existing" : "new",
  );
  const [workspaceId, setWorkspaceId] = React.useState(workspaces[0]?.id ?? "");
  const [newName, setNewName] = React.useState(defaultName);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let targetId = workspaceId;
      if (mode === "new") {
        if (!newName.trim()) {
          setError("Enter a workspace name.");
          setBusy(false);
          return;
        }
        const created = await createWorkspace(newName.trim());
        targetId = created.id;
      } else if (!targetId) {
        setError("Select a workspace.");
        setBusy(false);
        return;
      }

      const result = await uploadOfficeFiles(targetId, files);
      if (result.errors.length > 0 || result.uploaded.length === 0) {
        const message = result.errors[0] ?? "Upload failed.";
        setError(message);
        onError(message);
        return;
      }
      const first = result.uploaded[0]!;
      await onUploaded(targetId, first.id);
    } catch (err) {
      const message = userFacingError(err, "Upload failed.");
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Where should these files go?"
      onClose={onClose}
      className="max-w-[400px]"
    >
      <p className="mb-3 text-[12px] text-ink-soft">
        {files.length === 1
          ? files[0]!.name
          : `${files.length} files ready to upload`}
      </p>

      <div className="mb-3 flex gap-1 rounded-[var(--radius-sm)] border border-line bg-[var(--paper)] p-1">
        <button
          type="button"
          disabled={workspaces.length === 0}
          className={
            "flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-[11.5px] font-medium disabled:opacity-40 " +
            (mode === "existing"
              ? "bg-surface text-ink shadow-sm"
              : "text-ink-soft hover:text-ink")
          }
          onClick={() => setMode("existing")}
        >
          Existing workspace
        </button>
        <button
          type="button"
          className={
            "flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-[11.5px] font-medium " +
            (mode === "new"
              ? "bg-surface text-ink shadow-sm"
              : "text-ink-soft hover:text-ink")
          }
          onClick={() => setMode("new")}
        >
          New workspace
        </button>
      </div>

      {mode === "existing" ? (
        <div className="mb-3 max-h-[220px] space-y-1 overflow-y-auto">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={
                "block w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-[12.5px] " +
                (workspaceId === workspace.id
                  ? "bg-accent-soft font-medium text-accent-hover"
                  : "text-ink hover:bg-sunken")
              }
              onClick={() => setWorkspaceId(workspace.id)}
            >
              {workspace.name}
            </button>
          ))}
        </div>
      ) : (
        <Input
          autoFocus
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Workspace name"
          className="mb-3"
          maxLength={100}
        />
      )}

      {error ? <p className="mb-3 text-[11px] text-danger">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </Dialog>
  );
}
