"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import { DocumentLibraryRow } from "@/components/libraries/document-library-row";
import {
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import {
  createWorkspace,
  deleteWorkspace,
  listRecentDocuments,
  listWorkspaces,
  renameWorkspace,
  type LibraryDocument,
  type Workspace,
} from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import { focusRingClass } from "@/lib/focus-scope";
import {
  filterOfficeUploadFiles,
  isOfficeUploadFile,
  uploadOfficeFiles,
} from "@/lib/office-upload";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const RECENT_HOME_LIMIT = 8;

/**
 * /app home — resume recent documents, enter workspaces, create / upload.
 * Complements the app sidebar; avoids a second navigation dashboard.
 */
export function WorkspacesHome() {
  const router = useRouter();
  const { toast } = useToast();
  const [workspaces, setWorkspaces] = React.useState<Workspace[] | null>(null);
  const [recent, setRecent] = React.useState<LibraryDocument[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
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
      const [nextWorkspaces, nextRecent] = await Promise.all([
        listWorkspaces(),
        listRecentDocuments().catch(() => [] as LibraryDocument[]),
      ]);
      setWorkspaces(nextWorkspaces);
      setRecent(nextRecent);
    } catch (err) {
      setError(userFacingError(err, "Could not load workspaces."));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const menuWorkspace =
    (workspaces ?? []).find((workspace) => workspace.id === menuId) ?? null;
  const recentPreview = (recent ?? []).slice(0, RECENT_HOME_LIMIT);
  const hasWorkspaces = (workspaces?.length ?? 0) > 0;
  const isEmpty =
    workspaces !== null && workspaces.length === 0 && (recent?.length ?? 0) === 0;

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
      setCreateOpen(false);
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
    <div
      className="relative mx-auto max-w-[880px] px-6 py-7 sm:px-8"
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

      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
            Home
          </h1>
          <p className="os-type-secondary mt-1 max-w-[46ch] text-ink-soft">
            Resume your work, open a workspace, or upload Office files.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            Upload
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setCreateOpen(true);
              setCreateError(null);
              setName("");
            }}
          >
            New workspace
          </Button>
        </div>
      </header>

      {error ? (
        <div className="mb-4">
          <PageError message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {workspaces === null && !error ? (
        <PageLoading variant="workspaces" />
      ) : null}

      {isEmpty ? (
        <PageEmpty
          title="Create your first workspace"
          description="Start empty, or upload a .docx / .pptx / .xlsx and choose where it should live."
        />
      ) : null}

      {recentPreview.length > 0 ? (
        <section className="mb-7" aria-labelledby="home-continue">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2
              id="home-continue"
              className="os-type-section"
            >
              Continue
            </h2>
            {(recent?.length ?? 0) > RECENT_HOME_LIMIT ? (
              <Link
                href="/app/recent"
                className={cn(
                  focusRingClass,
                  "os-type-meta rounded-[var(--radius-sm)] text-ink-faint hover:text-ink-soft",
                )}
              >
                View all
              </Link>
            ) : null}
          </div>
          <ul className="divide-y divide-line border-y border-line">
            {recentPreview.map((doc) => (
              <li key={doc.id}>
                <DocumentLibraryRow
                  href={documentPath(doc.workspaceId, doc.id)}
                  name={doc.name}
                  format={doc.format}
                  meta={`${doc.workspaceName} · ${formatUpdatedAt(doc.updatedAt)}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasWorkspaces ? (
        <section aria-labelledby="home-workspaces">
          <h2 id="home-workspaces" className="os-type-section mb-2">
            Workspaces
            {workspaces ? (
              <span className="font-normal normal-case tracking-normal">
                {" "}
                · {workspaces.length}
              </span>
            ) : null}
          </h2>
          <ul className="divide-y divide-line border-y border-line">
            {workspaces!.map((workspace) => {
              const previewNames = workspace.recentDocuments
                .slice(0, 3)
                .map((doc) => doc.name);
              return (
                <li key={workspace.id} className="group relative">
                  <Link
                    href={workspacePath(workspace.id)}
                    className={cn(
                      focusRingClass,
                      "flex min-w-0 items-center gap-3 py-2.5 pr-10 pl-1 transition-colors hover:bg-hover",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="os-type-label truncate font-medium text-ink">
                          {workspace.name}
                        </span>
                        <span className="os-type-meta shrink-0 text-ink-faint">
                          {workspace.documentCount}{" "}
                          {workspace.documentCount === 1 ? "file" : "files"}
                        </span>
                      </span>
                      <span className="os-type-meta mt-0.5 block truncate text-ink-faint">
                        Updated {formatUpdatedAt(workspace.updatedAt)}
                        {previewNames.length > 0 ? (
                          <>
                            <span aria-hidden className="mx-1 text-ink-faint/70">
                              ·
                            </span>
                            {previewNames.join(", ")}
                          </>
                        ) : (
                          <>
                            <span aria-hidden className="mx-1 text-ink-faint/70">
                              ·
                            </span>
                            No files yet
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    title="Workspace actions"
                    aria-label={`Actions for ${workspace.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuId === workspace.id}
                    ref={(node) => {
                      if (node) menuAnchorRefs.current.set(workspace.id, node);
                      else menuAnchorRefs.current.delete(workspace.id);
                    }}
                    className={cn(
                      focusRingClass,
                      "absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-ink-faint opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                    )}
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
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {draggingOver ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[var(--radius-lg)] bg-overlay/40 backdrop-blur-[1px]">
          <div className="rounded-[var(--radius-lg)] border border-dashed border-accent bg-surface px-8 py-6 text-center shadow-[var(--elevation-md)]">
            <p className="text-[length:var(--text-md)] font-semibold tracking-[-0.02em] text-ink">
              Drop Office files to upload
            </p>
            <p className="os-type-secondary mt-1 text-ink-soft">
              .docx · .pptx · .xlsx
            </p>
          </div>
        </div>
      ) : null}

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

      {createOpen ? (
        <Dialog
          title="New workspace"
          onClose={() => setCreateOpen(false)}
        >
          <form
            onSubmit={(event) => void handleCreate(event)}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace name"
              maxLength={100}
            />
            {createError ? (
              <p className="os-type-meta text-danger">{createError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={creating || !name.trim()}
              >
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {renameId ? (
        <Dialog title="Rename workspace" onClose={() => setRenameId(null)}>
          <form
            onSubmit={(event) => void handleRename(event)}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={100}
            />
            {actionError ? (
              <p className="os-type-meta text-danger">{actionError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRenameId(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !renameValue.trim()}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          title="Move workspace to Trash?"
          onClose={() => setDeleteTarget(null)}
        >
          <p className="os-type-secondary mb-4 text-ink-soft">
            Move{" "}
            <span className="font-medium text-ink">{deleteTarget.name}</span> to
            Trash. Files remain recoverable from Trash.
          </p>
          {actionError ? (
            <p className="os-type-meta mb-3 text-danger">{actionError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
            >
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
      <p className="os-type-secondary mb-3 text-ink-soft">
        {files.length === 1
          ? files[0]!.name
          : `${files.length} files ready to upload`}
      </p>

      <div className="mb-3 flex gap-1 rounded-[var(--radius-sm)] border border-line bg-paper p-1">
        <button
          type="button"
          disabled={workspaces.length === 0}
          className={cn(
            focusRingClass,
            "os-type-label flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 font-medium disabled:opacity-40",
            mode === "existing"
              ? "bg-surface text-ink shadow-[var(--elevation-xs)]"
              : "text-ink-soft hover:text-ink",
          )}
          onClick={() => setMode("existing")}
        >
          Existing workspace
        </button>
        <button
          type="button"
          className={cn(
            focusRingClass,
            "os-type-label flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 font-medium",
            mode === "new"
              ? "bg-surface text-ink shadow-[var(--elevation-xs)]"
              : "text-ink-soft hover:text-ink",
          )}
          onClick={() => setMode("new")}
        >
          New workspace
        </button>
      </div>

      {mode === "existing" ? (
        <div className="mb-3 max-h-[220px] space-y-0.5 overflow-y-auto">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={cn(
                focusRingClass,
                "os-type-label block w-full rounded-[var(--radius-sm)] px-3 py-2 text-left",
                workspaceId === workspace.id
                  ? "bg-accent-soft font-medium text-accent-hover"
                  : "text-ink hover:bg-sunken",
              )}
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

      {error ? <p className="os-type-meta mb-3 text-danger">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </Dialog>
  );
}
