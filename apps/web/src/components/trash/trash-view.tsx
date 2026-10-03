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
import {
  emptyTrash,
  purgeTrashSelection,
  purgeTrashedDocument,
  purgeTrashedWorkspace,
} from "@/lib/storage-api";
import {
  notifyStorageChanged,
  permanentDeleteConfirmBody,
  permanentWorkspaceDeleteConfirmCopy,
  removePurgedTrashItem,
  removePurgedTrashItems,
  trashDocumentActions,
  trashSelectionKey,
  trashWorkspaceActions,
} from "@/lib/storage-model";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";

type PurgeTarget =
  | { kind: "document"; item: TrashedDocument }
  | { kind: "workspace"; item: TrashedWorkspace }
  | {
      kind: "selection";
      workspaceIds: readonly string[];
      documentIds: readonly string[];
      count: number;
    }
  | { kind: "empty"; count: number };

function WorkspacePurgeConfirmBody({ name }: { name: string }) {
  const copy = permanentWorkspaceDeleteConfirmCopy(name);
  return (
    <div className="space-y-3">
      <p className="rounded-[var(--radius-sm)] border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] leading-snug text-danger">
        This permanently deletes an entire workspace and everything in it — not
        just one file.
      </p>
      <p className="text-[12.5px] leading-snug">{copy.lead}</p>
      <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-snug text-ink-soft">
        {copy.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="text-[12.5px] font-medium leading-snug text-ink">
        {copy.footer}
      </p>
    </div>
  );
}

/** Fixed-width slot so Select mode never shifts row layout. */
function SelectionSlot({
  visible,
  checked,
  disabled,
  label,
  onChange,
}: {
  visible: boolean;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
      {visible ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          className="h-3.5 w-3.5 accent-[var(--primary)]"
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : null}
    </span>
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
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [purgeTarget, setPurgeTarget] = React.useState<PurgeTarget | null>(
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
      setSelected(new Set());
      setSelecting(false);
    } catch (err) {
      setError(userFacingError(err, "Could not load trash."));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const allKeys = React.useMemo(() => {
    const keys: string[] = [];
    for (const item of workspaces ?? []) {
      keys.push(trashSelectionKey("workspace", item.id));
    }
    for (const item of documents ?? []) {
      keys.push(trashSelectionKey("document", item.id));
    }
    return keys;
  }, [workspaces, documents]);

  const allSelected =
    allKeys.length > 0 && allKeys.every((key) => selected.has(key));
  const selectedCount = selected.size;

  function toggleKey(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(allKeys) : new Set());
  }

  function exitSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

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

  function selectionFromKeys(keys: ReadonlySet<string>): {
    workspaceIds: string[];
    documentIds: string[];
  } {
    const workspaceIds: string[] = [];
    const documentIds: string[] = [];
    for (const key of keys) {
      if (key.startsWith("workspace:")) {
        workspaceIds.push(key.slice("workspace:".length));
      } else if (key.startsWith("document:")) {
        documentIds.push(key.slice("document:".length));
      }
    }
    return { workspaceIds, documentIds };
  }

  async function handlePurgeConfirm() {
    if (!purgeTarget || purgeBusy) return;
    setPurgeBusy(true);
    setPurgeError(null);
    const target = purgeTarget;
    try {
      if (target.kind === "document") {
        await purgeTrashedDocument(target.item.id);
        setDocuments((current) =>
          removePurgedTrashItem(current ?? [], target.item.id),
        );
        setSelected((current) => {
          const next = new Set(current);
          next.delete(trashSelectionKey("document", target.item.id));
          return next;
        });
        toast({ tone: "success", title: "Document permanently deleted" });
      } else if (target.kind === "workspace") {
        const workspaceId = target.item.id;
        await purgeTrashedWorkspace(workspaceId);
        setWorkspaces((current) =>
          removePurgedTrashItem(current ?? [], workspaceId),
        );
        setDocuments((current) =>
          (current ?? []).filter((row) => row.workspaceId !== workspaceId),
        );
        setSelected((current) => {
          const next = new Set(current);
          next.delete(trashSelectionKey("workspace", workspaceId));
          for (const doc of documents ?? []) {
            if (doc.workspaceId === workspaceId) {
              next.delete(trashSelectionKey("document", doc.id));
            }
          }
          return next;
        });
        toast({ tone: "success", title: "Workspace permanently deleted" });
      } else if (target.kind === "selection") {
        await purgeTrashSelection({
          workspaceIds: target.workspaceIds,
          documentIds: target.documentIds,
        });
        const workspaceIdSet = new Set(target.workspaceIds);
        const documentIdSet = new Set(target.documentIds);
        setWorkspaces((current) =>
          removePurgedTrashItems(current ?? [], workspaceIdSet),
        );
        setDocuments((current) =>
          (current ?? []).filter(
            (row) =>
              !documentIdSet.has(row.id) && !workspaceIdSet.has(row.workspaceId),
          ),
        );
        setSelected(new Set());
        toast({
          tone: "success",
          title:
            target.count === 1
              ? "Item permanently deleted"
              : `${target.count} items permanently deleted`,
        });
      } else {
        await emptyTrash();
        setWorkspaces([]);
        setDocuments([]);
        setSelected(new Set());
        setSelecting(false);
        toast({ tone: "success", title: "Trash emptied" });
      }
      setPurgeTarget(null);
      notifyStorageChanged();
    } catch (err) {
      const fallback =
        target.kind === "document"
          ? "Could not permanently delete document."
          : target.kind === "workspace"
            ? "Could not permanently delete workspace."
            : target.kind === "selection"
              ? "Could not permanently delete selected items."
              : "Could not empty trash.";
      const message = userFacingError(err, fallback);
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

  function closePurgeDialog() {
    if (purgeBusy) return;
    setPurgeTarget(null);
    setPurgeError(null);
  }

  const empty =
    workspaces !== null &&
    documents !== null &&
    workspaces.length === 0 &&
    documents.length === 0;

  const workspaceActions = trashWorkspaceActions();
  const totalCount = (workspaces?.length ?? 0) + (documents?.length ?? 0);
  const anyBusy = busyId !== null || purgeBusy;

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
            Trash
          </h1>
          <p className="os-type-secondary mt-1 text-ink-soft">
            Soft-deleted workspaces and documents. Restore items, or permanently
            delete them to free storage.
          </p>
        </div>
        {!empty && workspaces !== null ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {selecting && selectedCount > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-danger hover:bg-danger-soft hover:text-danger"
                disabled={anyBusy}
                onClick={() => {
                  const selection = selectionFromKeys(selected);
                  setPurgeError(null);
                  setPurgeTarget({
                    kind: "selection",
                    workspaceIds: selection.workspaceIds,
                    documentIds: selection.documentIds,
                    count: selectedCount,
                  });
                }}
              >
                Delete selected ({selectedCount})
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={anyBusy || totalCount === 0}
              aria-pressed={selecting}
              onClick={() => {
                if (selecting) exitSelecting();
                else setSelecting(true);
              }}
            >
              {selecting ? "Done" : "Select"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-danger hover:border-danger/40 hover:bg-danger-soft hover:text-danger"
              disabled={anyBusy || totalCount === 0}
              onClick={() => {
                setPurgeError(null);
                setPurgeTarget({ kind: "empty", count: totalCount });
              }}
            >
              Empty trash
            </Button>
          </div>
        ) : null}
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

      {selecting && selectedCount > 0 && !empty ? (
        <div className="mb-3 flex h-5 items-center gap-2 px-1">
          <SelectionSlot
            visible
            checked={allSelected}
            disabled={anyBusy || allKeys.length === 0}
            label="Select all trash items"
            onChange={toggleSelectAll}
          />
          <button
            type="button"
            className="os-type-meta text-ink-soft hover:text-ink"
            disabled={anyBusy || allKeys.length === 0}
            onClick={() => toggleSelectAll(!allSelected)}
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
          <span className="os-type-meta text-ink-faint">
            · {selectedCount} selected
          </span>
        </div>
      ) : null}

      {(workspaces?.length ?? 0) > 0 ? (
        <section className="mb-8">
          <h2 className="os-type-section mb-2">Workspaces</h2>
          <div className="flex flex-col gap-1.5">
            {workspaces!.map((item) => {
              const rowBusy = busyId === item.id;
              const key = trashSelectionKey("workspace", item.id);
              const isSelected = selected.has(key);
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5",
                    selecting && isSelected && "border-primary/35 bg-primary-soft/40",
                  )}
                >
                  <SelectionSlot
                    visible={selecting}
                    checked={isSelected}
                    disabled={anyBusy}
                    label={`Select workspace ${item.name}`}
                    onChange={(checked) => toggleKey(key, checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="os-type-label truncate font-medium text-ink">
                      {item.name}
                    </div>
                    <div className="os-type-meta text-ink-faint">
                      Workspace · Deleted {formatUpdatedAt(item.deletedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {workspaceActions.canRestore ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={rowBusy || purgeBusy}
                        onClick={() => void handleRestoreWorkspace(item)}
                      >
                        {rowBusy ? "Restoring…" : "Restore"}
                      </Button>
                    ) : null}
                    {workspaceActions.canPermanentlyDelete ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-danger-soft hover:text-danger"
                        disabled={rowBusy || purgeBusy}
                        onClick={() => {
                          setPurgeError(null);
                          setPurgeTarget({ kind: "workspace", item });
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

      {(documents?.length ?? 0) > 0 ? (
        <section>
          <h2 className="os-type-section mb-2">Documents</h2>
          <div className="flex flex-col gap-1.5">
            {documents!.map((item) => {
              const actions = trashDocumentActions({
                workspaceDeleted: item.workspaceDeleted,
              });
              const rowBusy = busyId === item.id;
              const key = trashSelectionKey("document", item.id);
              const isSelected = selected.has(key);
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5",
                    selecting && isSelected && "border-primary/35 bg-primary-soft/40",
                  )}
                >
                  <SelectionSlot
                    visible={selecting}
                    checked={isSelected}
                    disabled={anyBusy}
                    label={`Select document ${item.name}`}
                    onChange={(checked) => toggleKey(key, checked)}
                  />
                  <DocumentFormatIcon
                    format={item.format}
                    size="md"
                    className="shrink-0 text-ink-soft"
                  />
                  <div className="min-w-0 flex-1">
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
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rowBusy || !actions.canRestore || purgeBusy}
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
                          setPurgeTarget({ kind: "document", item });
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

      {purgeTarget?.kind === "document" ? (
        <ConfirmDialog
          title="Delete forever?"
          body={permanentDeleteConfirmBody(purgeTarget.item.name)}
          confirmLabel="Delete forever"
          tone="danger"
          busy={purgeBusy}
          error={purgeError}
          onCancel={closePurgeDialog}
          onConfirm={() => void handlePurgeConfirm()}
        />
      ) : null}

      {purgeTarget?.kind === "workspace" ? (
        <ConfirmDialog
          title="Delete workspace forever?"
          body={<WorkspacePurgeConfirmBody name={purgeTarget.item.name} />}
          confirmLabel="Delete forever"
          tone="danger"
          busy={purgeBusy}
          error={purgeError}
          className="max-w-[440px] border-danger/30"
          onCancel={closePurgeDialog}
          onConfirm={() => void handlePurgeConfirm()}
        />
      ) : null}

      {purgeTarget?.kind === "selection" ? (
        <ConfirmDialog
          title="Delete selected forever?"
          body={
            purgeTarget.count === 1
              ? "The selected item will be permanently deleted. Saved versions and storage they use will be removed. This cannot be undone."
              : `${purgeTarget.count} selected items will be permanently deleted. Saved versions and storage they use will be removed. This cannot be undone.`
          }
          confirmLabel="Delete forever"
          tone="danger"
          busy={purgeBusy}
          error={purgeError}
          onCancel={closePurgeDialog}
          onConfirm={() => void handlePurgeConfirm()}
        />
      ) : null}

      {purgeTarget?.kind === "empty" ? (
        <ConfirmDialog
          title="Empty trash?"
          body={
            <div className="space-y-3">
              <p className="rounded-[var(--radius-sm)] border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] leading-snug text-danger">
                This permanently deletes every workspace and document currently
                in Trash.
              </p>
              <p className="text-[12.5px] leading-snug">
                {purgeTarget.count === 1
                  ? "1 item will be removed forever. Storage will be reclaimed. This cannot be undone."
                  : `${purgeTarget.count} items will be removed forever. Storage will be reclaimed. This cannot be undone.`}
              </p>
            </div>
          }
          confirmLabel="Empty trash"
          tone="danger"
          busy={purgeBusy}
          error={purgeError}
          className="max-w-[440px] border-danger/30"
          onCancel={closePurgeDialog}
          onConfirm={() => void handlePurgeConfirm()}
        />
      ) : null}
    </div>
  );
}
