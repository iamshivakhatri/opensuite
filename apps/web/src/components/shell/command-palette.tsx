"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  formatLabel,
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import { Button } from "@/components/ui/button";
import { PromptDialog } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import {
  createBlankDocument,
  createWorkspace,
  listRecentDocuments,
  listWorkspaces,
  searchMetadata,
  uploadDocument,
  type LibraryDocument,
  type SearchDocumentHit,
  type SearchWorkspaceHit,
  type Workspace,
} from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import { useToast } from "@/lib/toast";

type PaletteItem =
  | {
      kind: "document";
      id: string;
      title: string;
      subtitle: string;
      format: SearchDocumentHit["format"];
      href: string;
    }
  | {
      kind: "workspace";
      id: string;
      title: string;
      subtitle: string;
      href: string;
    }
  | {
      kind: "command";
      id: string;
      title: string;
      subtitle: string;
      run: () => void | Promise<void>;
    };

type CommandPaletteContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open upload flow (workspace picker when not already inside a workspace). */
  openUpload: () => void;
};

const CommandPaletteContext =
  React.createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette() {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  }
  return ctx;
}

function currentWorkspaceId(pathname: string): string | null {
  const match = /^\/app\/workspaces\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * Global Cmd/Ctrl+K palette — recent docs, metadata search, real commands.
 */
export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [startInUploadPick, setStartInUploadPick] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((value) => !value), []);

  const openUpload = React.useCallback(() => {
    const inWorkspace = currentWorkspaceId(pathname);
    if (inWorkspace) {
      // Workspace IDE owns ⌘O when a workspace is open.
      window.dispatchEvent(
        new CustomEvent("opensuite:upload-request", {
          detail: { workspaceId: inWorkspace },
        }),
      );
      return;
    }
    setStartInUploadPick(true);
    setOpen(true);
  }, [pathname]);

  React.useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
    }

    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        toggle();
        return;
      }
      if (key === "o") {
        // Inside a workspace, WorkspaceIde handles ⌘O directly.
        if (currentWorkspaceId(pathname)) return;
        event.preventDefault();
        openUpload();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openUpload, pathname, toggle]);

  React.useEffect(() => {
    setOpen(false);
    setStartInUploadPick(false);
  }, [pathname]);

  return (
    <CommandPaletteContext.Provider value={{ open, setOpen, toggle, openUpload }}>
      {children}
      {open ? (
        <CommandPalette
          onClose={() => {
            setOpen(false);
            setStartInUploadPick(false);
          }}
          startInUploadPick={startInUploadPick}
        />
      ) : null}
    </CommandPaletteContext.Provider>
  );
}

function CommandPalette({
  onClose,
  startInUploadPick = false,
}: {
  onClose: () => void;
  startInUploadPick?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [recent, setRecent] = React.useState<LibraryDocument[]>([]);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [docHits, setDocHits] = React.useState<SearchDocumentHit[]>([]);
  const [wsHits, setWsHits] = React.useState<SearchWorkspaceHit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [pickWorkspaceForUpload, setPickWorkspaceForUpload] =
    React.useState(startInUploadPick);
  const [pickWorkspaceForBlank, setPickWorkspaceForBlank] = React.useState(false);
  const [uploadWorkspaceId, setUploadWorkspaceId] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 160);
    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([listRecentDocuments(), listWorkspaces()])
      .then(([recentDocs, ws]) => {
        if (cancelled) return;
        setRecent(recentDocs.slice(0, 8));
        setWorkspaces(ws);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(userFacingError(err, "Could not load quick open data."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!debounced) {
      setDocHits([]);
      setWsHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void searchMetadata(debounced)
      .then((results) => {
        if (cancelled) return;
        setDocHits(results.documents);
        setWsHits(results.workspaces);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(userFacingError(err, "Search failed."));
          setDocHits([]);
          setWsHits([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const runUpload = React.useCallback(
    (workspaceId: string) => {
      setUploadWorkspaceId(workspaceId);
      setPickWorkspaceForUpload(false);
      // Defer so the picker closes before the file dialog.
      window.setTimeout(() => fileRef.current?.click(), 0);
    },
    [],
  );

  const runCreateBlank = React.useCallback(
    async (workspaceId: string) => {
      setPickWorkspaceForBlank(false);
      try {
        const created = await createBlankDocument(workspaceId);
        onClose();
        toast({ tone: "success", title: "Document created" });
        router.push(documentPath(workspaceId, created.document.id));
      } catch (err) {
        setError(userFacingError(err, "Could not create document."));
        toast({
          tone: "error",
          title: "Create failed",
          description: userFacingError(err, "Could not create a blank document."),
        });
      }
    },
    [onClose, router, toast],
  );

  const commands = React.useMemo((): PaletteItem[] => {
    const go = (href: string) => {
      onClose();
      router.push(href);
    };
    const all: PaletteItem[] = [
      {
        kind: "command",
        id: "cmd-create-workspace",
        title: "Create Workspace",
        subtitle: "Command",
        run: () => {
          setCreateError(null);
          setCreateOpen(true);
        },
      },
      {
        kind: "command",
        id: "cmd-upload",
        title: "Upload File",
        subtitle: "Command",
        run: () => {
          const inWorkspace = currentWorkspaceId(pathname);
          if (inWorkspace) {
            runUpload(inWorkspace);
            return;
          }
          setPickWorkspaceForUpload(true);
        },
      },
      {
        kind: "command",
        id: "cmd-new-document",
        title: "New Document",
        subtitle: "Command",
        run: () => {
          const inWorkspace = currentWorkspaceId(pathname);
          if (inWorkspace) {
            void runCreateBlank(inWorkspace);
            return;
          }
          setPickWorkspaceForBlank(true);
        },
      },
      {
        kind: "command",
        id: "cmd-workspaces",
        title: "Go to Workspaces",
        subtitle: "Command",
        run: () => go("/app"),
      },
      {
        kind: "command",
        id: "cmd-recent",
        title: "Go to Recent",
        subtitle: "Command",
        run: () => go("/app/recent"),
      },
      {
        kind: "command",
        id: "cmd-starred",
        title: "Go to Starred",
        subtitle: "Command",
        run: () => go("/app/starred"),
      },
      {
        kind: "command",
        id: "cmd-trash",
        title: "Go to Trash",
        subtitle: "Command",
        run: () => go("/app/trash"),
      },
      {
        kind: "command",
        id: "cmd-settings",
        title: "Go to Settings",
        subtitle: "Command",
        run: () => go("/app/settings"),
      },
      {
        kind: "command",
        id: "cmd-search-page",
        title: "Open Search Page",
        subtitle: "Command",
        run: () =>
          go(
            debounced
              ? `/app/search?q=${encodeURIComponent(debounced)}`
              : "/app/search",
          ),
      },
    ];

    if (!debounced) return all;
    const needle = debounced.toLowerCase();
    return all.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.subtitle.toLowerCase().includes(needle),
    );
  }, [debounced, onClose, pathname, router, runCreateBlank, runUpload]);

  const openWorkspaceCommands = React.useMemo((): PaletteItem[] => {
    if (!debounced) {
      return workspaces.slice(0, 6).map((ws) => ({
        kind: "workspace" as const,
        id: `ws-${ws.id}`,
        title: ws.name,
        subtitle: "Open workspace",
        href: workspacePath(ws.id),
      }));
    }
    return wsHits.map((ws) => ({
      kind: "workspace" as const,
      id: `ws-${ws.id}`,
      title: ws.name,
      subtitle: "Open workspace",
      href: workspacePath(ws.id),
    }));
  }, [debounced, workspaces, wsHits]);

  const items = React.useMemo((): PaletteItem[] => {
    if (!debounced) {
      const recentItems: PaletteItem[] = recent.map((doc) => ({
        kind: "document",
        id: `recent-${doc.id}`,
        title: doc.name,
        subtitle: `${doc.workspaceName} · ${formatLabel(doc.format)} · Opened ${formatUpdatedAt(doc.lastOpenedAt ?? doc.updatedAt)}`,
        format: doc.format,
        href: documentPath(doc.workspaceId, doc.id),
      }));
      return [...recentItems, ...openWorkspaceCommands, ...commands];
    }

    const docs: PaletteItem[] = docHits.map((doc) => ({
      kind: "document",
      id: `doc-${doc.id}`,
      title: doc.name,
      subtitle: `${doc.workspaceName} · ${formatLabel(doc.format)} · Updated ${formatUpdatedAt(doc.updatedAt)}`,
      format: doc.format,
      href: documentPath(doc.workspaceId, doc.id),
    }));
    return [...docs, ...openWorkspaceCommands, ...commands];
  }, [
    commands,
    debounced,
    docHits,
    openWorkspaceCommands,
    recent,
  ]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [items]);

  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  async function activate(item: PaletteItem) {
    if (item.kind === "command") {
      await item.run();
      return;
    }
    onClose();
    router.push(item.href);
  }

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (createOpen || pickWorkspaceForUpload || pickWorkspaceForBlank) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (createOpen || pickWorkspaceForUpload || pickWorkspaceForBlank) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) =>
          items.length === 0 ? 0 : (index + 1) % items.length,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) =>
          items.length === 0
            ? 0
            : (index - 1 + items.length) % items.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = items[activeIndex];
        if (item) void activate(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function handleCreate(name: string) {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(name);
      setCreateOpen(false);
      onClose();
      toast({ tone: "success", title: "Workspace created" });
      router.push(workspacePath(workspace.id));
    } catch (err) {
      setCreateError(userFacingError(err, "Could not create workspace."));
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleFileChosen(file: File | undefined) {
    if (!file || !uploadWorkspaceId) return;
    try {
      const uploaded = await uploadDocument(uploadWorkspaceId, file);
      onClose();
      toast({ tone: "success", title: "File uploaded" });
      router.push(documentPath(uploadWorkspaceId, uploaded.document.id));
    } catch (err) {
      setError(userFacingError(err, "Upload failed."));
      toast({
        tone: "error",
        title: "Upload failed",
        description: userFacingError(err, "Could not upload this file."),
      });
    } finally {
      setUploadWorkspaceId(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[60] flex items-start justify-center bg-overlay px-4 pt-[12vh] backdrop-blur-[6px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          className="w-full max-w-[560px] overflow-hidden rounded-[16px] border border-line bg-surface shadow-[0_28px_100px_rgba(15,18,24,0.22)]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-line px-4 py-3">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files, workspaces, or run a command…"
              className="w-full border-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          <div ref={listRef} className="max-h-[420px] overflow-y-auto p-2">
            {error ? (
              <p className="px-2 py-3 text-[11px] text-danger">{error}</p>
            ) : null}
            {loading ? (
              <p className="px-2 py-3 text-[11px] text-ink-faint">Searching…</p>
            ) : null}
            {!loading && items.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-ink-faint">
                {debounced
                  ? "No matching files or commands."
                  : "No recent files yet. Start typing to search."}
              </p>
            ) : null}

            {items.map((item, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-palette-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void activate(item)}
                  className={
                    "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left " +
                    (active ? "bg-accent-soft" : "hover:bg-sunken")
                  }
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] font-mono text-[7.5px] text-ink-soft">
                    {item.kind === "document"
                      ? formatLabel(item.format)
                      : item.kind === "workspace"
                        ? "WS"
                        : "⌘"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        "block truncate text-[12.5px] " +
                        (active
                          ? "font-semibold text-accent-hover"
                          : "font-medium text-ink")
                      }
                    >
                      {item.title}
                    </span>
                    <span className="block truncate text-[10.5px] text-ink-faint">
                      {item.subtitle}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[10px] text-ink-faint">
            <span>↑↓ navigate · ↵ open · esc close</span>
            <span>⌘K / Ctrl+K</span>
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".docx,.pptx,.xlsx"
        className="hidden"
        onChange={(event) =>
          void handleFileChosen(event.target.files?.[0] ?? undefined)
        }
      />

      {createOpen ? (
        <PromptDialog
          title="Create workspace"
          initialValue=""
          busy={createBusy}
          error={createError}
          onCancel={() => setCreateOpen(false)}
          onSubmit={(name) => void handleCreate(name)}
        />
      ) : null}

      {pickWorkspaceForUpload ? (
        <Dialog
          title="Upload to workspace"
          onClose={() => setPickWorkspaceForUpload(false)}
          overlayClassName="z-[var(--z-popover)]"
        >
          {workspaces.length === 0 ? (
            <p className="text-[12px] text-ink-soft">
              Create a workspace first, then upload a file.
            </p>
          ) : (
            <div className="max-h-[280px] space-y-1 overflow-y-auto">
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  className="block w-full rounded-[var(--radius-md)] px-3 py-2 text-left text-[12.5px] text-ink hover:bg-sunken"
                  onClick={() => runUpload(ws.id)}
                >
                  {ws.name}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPickWorkspaceForUpload(false)}
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}

      {pickWorkspaceForBlank ? (
        <Dialog
          title="New document in workspace"
          onClose={() => setPickWorkspaceForBlank(false)}
          overlayClassName="z-[var(--z-popover)]"
        >
          {workspaces.length === 0 ? (
            <p className="text-[12px] text-ink-soft">
              Create a workspace first, then create a document.
            </p>
          ) : (
            <div className="max-h-[280px] space-y-1 overflow-y-auto">
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  className="block w-full rounded-[var(--radius-md)] px-3 py-2 text-left text-[12.5px] text-ink hover:bg-sunken"
                  onClick={() => void runCreateBlank(ws.id)}
                >
                  {ws.name}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPickWorkspaceForBlank(false)}
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
