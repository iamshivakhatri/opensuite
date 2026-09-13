"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  type Workspace,
} from "@/lib/api";
import { workspacePath } from "@/lib/paths";
import { useCommandPalette } from "@/components/shell/command-palette";
import { useToast } from "@/lib/toast";

const mainNav = [
  { href: "/app", label: "Home", icon: "nav-home" as const, match: "exact" as const },
  { href: "/app/recent", label: "Recent", icon: "nav-recent" as const, match: "prefix" as const },
  {
    href: "/app/starred",
    label: "Starred",
    icon: "nav-starred" as const,
    match: "prefix" as const,
  },
  { href: "/app/trash", label: "Trash", icon: "nav-trash" as const, match: "prefix" as const },
];

function NavIcon({
  name,
  active,
}: {
  name: "nav-home" | "nav-recent" | "nav-starred" | "nav-trash";
  active: boolean;
}) {
  const stroke = active ? "currentColor" : "currentColor";
  const className = "h-[14px] w-[14px]";
  if (name === "nav-home") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
        <path
          d="M2.5 7.2 8 2.8l5.5 4.4V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V7.2Z"
          stroke={stroke}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M6.2 14V9.2h3.6V14"
          stroke={stroke}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (name === "nav-recent") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
        <circle cx="8" cy="8" r="5.5" stroke={stroke} strokeWidth="1.4" />
        <path d="M8 5v3.2L10 10" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "nav-starred") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
        <path
          d="M8 2.4l1.5 3.2 3.5.4-2.6 2.4.7 3.4L8 10.4 4.9 11.8l.7-3.4L3 6l3.5-.4L8 2.4z"
          stroke={stroke}
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path d="M3 4.5h10" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M5.5 4.5V3.6c0-.3.2-.6.5-.6h4c.3 0 .5.3.5.6v.9"
        stroke={stroke}
        strokeWidth="1.4"
      />
      <path
        d="M4.2 4.5l.6 8c0 .4.4.7.8.7h5c.4 0 .7-.3.8-.7l.6-8"
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isActive(
  pathname: string,
  href: string,
  match: "exact" | "prefix",
): boolean {
  if (match === "exact") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Application sidebar — every visible item is functional.
 */
export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { setOpen: openPalette } = useCommandPalette();
  const { toast } = useToast();
  const [workspaces, setWorkspaces] = React.useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [menuId, setMenuId] = React.useState<string | null>(null);
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<Workspace | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const menuAnchorRefs = React.useRef<Map<string, HTMLButtonElement>>(
    new Map(),
  );

  const refresh = React.useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(userFacingError(error, "Could not load workspaces."));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  const menuWorkspace =
    (workspaces ?? []).find((workspace) => workspace.id === menuId) ?? null;

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(createName);
      setCreateOpen(false);
      setCreateName("");
      await refresh();
      toast({ tone: "success", title: "Workspace created" });
      router.push(workspacePath(workspace.id));
    } catch (error) {
      setCreateError(userFacingError(error, "Could not create workspace."));
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
      await refresh();
      toast({ tone: "success", title: "Workspace renamed" });
    } catch (error) {
      setActionError(userFacingError(error, "Could not rename workspace."));
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
      await refresh();
      toast({ tone: "success", title: "Moved to Trash" });
      if (pathname.startsWith(`/app/workspaces/${deleteTarget.id}`)) {
        router.push("/app");
      }
    } catch (error) {
      setActionError(userFacingError(error, "Could not delete workspace."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex w-[236px] shrink-0 flex-col gap-4 border-r border-line bg-sidebar px-2.5 py-4">
      <div>
        <button
          type="button"
          onClick={() => openPalette(true)}
          className="os-type-label mb-3 flex w-full items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-2 text-left text-ink-faint shadow-[0_1px_2px_rgba(16,24,40,0.025)] hover:border-primary-line hover:text-primary"
        >
          <span className="text-[length:var(--text-sm)]">⌕</span>
          <span className="min-w-0 flex-1">Search</span>
          <kbd className="os-type-meta rounded border border-line bg-[var(--paper)] px-1.5 py-0.5 font-mono text-ink-faint">
            ⌘K
          </kbd>
        </button>
        <div className="os-type-section mb-1.5 px-2.5">
          Navigate
        </div>
        <div className="flex flex-col gap-0.5">
          {mainNav.map((item) => {
            const active = isActive(pathname, item.href, item.match);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "os-type-label flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 transition-colors " +
                  (active
                      ? "bg-primary-soft font-semibold text-primary-hover shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)]"
                    : "text-ink-soft hover:bg-primary-soft hover:text-primary")
                }
              >
                <span
                  className={
                    "grid w-4 place-items-center " +
                    (active ? "text-accent" : "text-ink-faint")
                  }
                >
                  <NavIcon name={item.icon} active={active} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="mb-1.5 flex items-center justify-between px-2.5">
          <span className="os-type-section">Workspaces</span>
          <button
            type="button"
            title="Create workspace"
            onClick={(event) => {
              event.stopPropagation();
              setCreateOpen(true);
              setCreateError(null);
            }}
            className="grid h-5 w-5 place-items-center rounded text-[length:var(--text-xs)] text-ink-faint hover:bg-primary-soft hover:text-primary"
          >
            +
          </button>
        </div>

        {loadError ? (
          <p className="os-type-meta px-2.5 text-danger">{loadError}</p>
        ) : null}
        {workspaces === null && !loadError ? (
          <div className="space-y-1 px-2.5 py-1">
            <PageLoading variant="inline" />
          </div>
        ) : null}

        <div className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
          {(workspaces ?? []).map((workspace) => {
            const active = pathname.startsWith(
              `/app/workspaces/${workspace.id}`,
            );
            return (
              <div key={workspace.id} className="relative">
                <Link
                  href={workspacePath(workspace.id)}
                  className={
                    "os-type-label flex items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pl-2.5 pr-7 " +
                    (active
                      ? "bg-accent-soft font-medium text-accent-hover"
                      : "text-ink-soft hover:bg-primary-soft hover:text-primary")
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                </Link>
                <button
                  type="button"
                  title="Workspace actions"
                  ref={(node) => {
                    if (node) menuAnchorRefs.current.set(workspace.id, node);
                    else menuAnchorRefs.current.delete(workspace.id);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuId((current) =>
                      current === workspace.id ? null : workspace.id,
                    );
                  }}
                  className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-[length:var(--text-xs)] text-ink-faint hover:bg-primary-soft hover:text-primary"
                >
                  ···
                </button>
              </div>
            );
          })}
          {workspaces !== null && workspaces.length === 0 ? (
            <p className="os-type-meta px-2.5 text-ink-faint">
              No workspaces yet.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-auto border-t border-line pt-3">
        <Link
          href="/app/settings"
          className={
            "os-type-label flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 " +
            (isActive(pathname, "/app/settings", "prefix")
              ? "bg-accent-soft font-semibold text-accent-hover"
              : "text-ink-soft hover:bg-primary-soft hover:text-primary")
          }
        >
          <span className="w-4 text-center text-[length:var(--text-sm)] text-ink-faint">
            ⚙
          </span>
          Settings
        </Link>
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

      {createOpen ? (
        <Dialog onClose={() => setCreateOpen(false)} title="New workspace">
          <form onSubmit={(event) => void handleCreate(event)} className="space-y-3">
            <Input
              autoFocus
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
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
              <Button type="submit" size="sm" disabled={creating || !createName.trim()}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {renameId ? (
        <Dialog onClose={() => setRenameId(null)} title="Rename workspace">
          <form onSubmit={(event) => void handleRename(event)} className="space-y-3">
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
              <Button type="submit" size="sm" disabled={busy || !renameValue.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          onClose={() => setDeleteTarget(null)}
          title="Move workspace to Trash?"
        >
          <p className="os-type-secondary mb-4 leading-relaxed text-ink-soft">
            Move <span className="font-medium text-ink">{deleteTarget.name}</span>{" "}
            to Trash. Documents and history are kept and can be restored later.
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
    </aside>
  );
}
