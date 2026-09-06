"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { PageLoading } from "@/components/ui/page-state";

const mainNav = [
  { href: "/app", label: "Workspaces", icon: "nav-workspaces" as const, match: "exact" as const },
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
  name: "nav-workspaces" | "nav-recent" | "nav-starred" | "nav-trash";
  active: boolean;
}) {
  const stroke = active ? "currentColor" : "currentColor";
  const className = "h-[14px] w-[14px]";
  if (name === "nav-workspaces") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
        <rect x="2" y="2" width="5" height="5" rx="1" stroke={stroke} strokeWidth="1.4" />
        <rect x="9" y="2" width="5" height="5" rx="1" stroke={stroke} strokeWidth="1.4" />
        <rect x="2" y="9" width="5" height="5" rx="1" stroke={stroke} strokeWidth="1.4" />
        <rect x="9" y="9" width="5" height="5" rx="1" stroke={stroke} strokeWidth="1.4" />
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

const appFilters = [
  {
    href: "/app/write",
    label: "Write",
    icon: <path d="M4 19h4l10-10a2.2 2.2 0 0 0-3-3L5 16v3z" />,
  },
  {
    href: "/app/slides",
    label: "Slides",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="12" rx="1.5" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    ),
  },
  {
    href: "/app/sheets",
    label: "Sheets",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="1.5" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="10.5" y1="3" x2="10.5" y2="21" />
      </>
    ),
  },
];

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

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuId(null);
        setCreateOpen(false);
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
    <aside className="flex w-[236px] shrink-0 flex-col gap-4 border-r border-line bg-[var(--sidebar)] px-2.5 py-4">
      <div>
        <button
          type="button"
          onClick={() => openPalette(true)}
          className="mb-3 flex w-full items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-2 text-left text-[12px] text-ink-faint shadow-[0_1px_2px_rgba(16,24,40,0.025)] hover:border-[#D5D9E0] hover:text-ink"
        >
          <span className="text-[13px]">⌕</span>
          <span className="min-w-0 flex-1">Search</span>
          <kbd className="rounded border border-line bg-[var(--paper)] px-1.5 py-0.5 font-mono text-[9px] text-ink-faint">
            ⌘K
          </kbd>
        </button>
        <div className="mb-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
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
                  "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[12px] transition-colors " +
                  (active
                    ? "bg-accent-soft font-semibold text-accent-hover shadow-[inset_0_0_0_1px_rgba(91,92,226,0.05)]"
                    : "text-ink-soft hover:bg-sunken hover:text-ink")
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
          <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
            Workspaces
          </span>
          <button
            type="button"
            title="Create workspace"
            onClick={(event) => {
              event.stopPropagation();
              setCreateOpen(true);
              setCreateError(null);
            }}
            className="grid h-5 w-5 place-items-center rounded text-[12px] text-ink-faint hover:bg-sunken hover:text-ink"
          >
            +
          </button>
        </div>

        {loadError ? (
          <p className="px-2.5 text-[10.5px] text-danger">{loadError}</p>
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
                    "flex items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pl-2.5 pr-7 text-[12px] " +
                    (active
                      ? "bg-accent-soft font-medium text-accent-hover"
                      : "text-ink-soft hover:bg-sunken hover:text-ink")
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                </Link>
                <button
                  type="button"
                  title="Workspace actions"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuId((current) =>
                      current === workspace.id ? null : workspace.id,
                    );
                  }}
                  className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-[12px] text-ink-faint hover:bg-sunken hover:text-ink"
                >
                  ···
                </button>
                {menuId === workspace.id ? (
                  <div
                    className="absolute right-0 top-8 z-20 min-w-[140px] overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface py-1 shadow-[0_8px_28px_rgba(15,18,24,0.12)]"
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
            );
          })}
          {workspaces !== null && workspaces.length === 0 ? (
            <p className="px-2.5 text-[10.5px] text-ink-faint">
              No workspaces yet.
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <div className="mb-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          Apps
        </div>
        <div className="grid grid-cols-3 gap-[7px] px-0.5">
          {appFilters.map((item) => {
            const active = isActive(pathname, item.href, "prefix");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "flex h-[58px] flex-col items-center justify-center gap-[5px] rounded-[var(--radius-sm)] border text-[10px] shadow-[0_1px_2px_rgba(16,24,40,0.025)] " +
                  (active
                    ? "border-accent-line bg-accent-soft text-accent-hover"
                    : "border-line bg-surface text-ink-soft hover:border-[#D5D9E0]")
                }
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.7}
                  className="h-[17px] w-[17px]"
                  aria-hidden
                >
                  {item.icon}
                </svg>
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="mt-auto border-t border-line pt-3">
        <Link
          href="/app/settings"
          className={
            "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[12px] " +
            (isActive(pathname, "/app/settings", "prefix")
              ? "bg-accent-soft font-semibold text-accent-hover"
              : "text-ink-soft hover:bg-sunken hover:text-ink")
          }
        >
          <span className="w-4 text-center text-[13px] text-ink-faint">⚙</span>
          Settings
        </Link>
      </div>

      {createOpen ? (
        <Modal onClose={() => setCreateOpen(false)} title="New workspace">
          <form onSubmit={(event) => void handleCreate(event)} className="space-y-3">
            <Input
              autoFocus
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Workspace name"
              maxLength={100}
            />
            {createError ? (
              <p className="text-[11px] text-danger">{createError}</p>
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
        </Modal>
      ) : null}

      {renameId ? (
        <Modal onClose={() => setRenameId(null)} title="Rename workspace">
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
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          onClose={() => setDeleteTarget(null)}
          title="Move workspace to Trash?"
        >
          <p className="mb-4 text-[12px] leading-relaxed text-ink-soft">
            Move <span className="font-medium text-ink">{deleteTarget.name}</span>{" "}
            to Trash. Documents and history are kept and can be restored later.
          </p>
          {actionError ? (
            <p className="mb-3 text-[11px] text-danger">{actionError}</p>
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
              className="bg-danger hover:bg-[#B0453A]"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? "Moving…" : "Move to Trash"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </aside>
  );
}

function Modal({
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
        className="w-full max-w-[380px] rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[0_24px_80px_rgba(15,18,24,0.2)]"
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
