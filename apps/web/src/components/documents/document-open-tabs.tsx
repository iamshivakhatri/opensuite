"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { formatLabel, userFacingError } from "@/components/files/format";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { listDocuments, type ListedDocument } from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import {
  estimateDocumentTabWidth,
  partitionTabsForOverflow,
} from "@/lib/tab-overflow";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "opensuite.openTabs:";

const TAB_MIN_WIDTH = 120;
const TAB_MAX_WIDTH = 176;
const OPEN_BUTTON_WIDTH = 32;
const OVERFLOW_BUTTON_WIDTH = 32;

export type OpenTabMeta = {
  readonly id: string;
  readonly name: string;
  readonly format: ListedDocument["format"];
};

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}${workspaceId}`;
}

export function readStoredTabs(workspaceId: string): OpenTabMeta[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is OpenTabMeta =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as OpenTabMeta).id === "string" &&
        typeof (item as OpenTabMeta).name === "string" &&
        typeof (item as OpenTabMeta).format === "string",
    );
  } catch {
    return [];
  }
}

export function writeStoredTabs(
  workspaceId: string,
  tabs: readonly OpenTabMeta[],
): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(tabs));
}

export function removeStoredTab(workspaceId: string, documentId: string): void {
  const next = readStoredTabs(workspaceId).filter((tab) => tab.id !== documentId);
  writeStoredTabs(workspaceId, next);
}

/**
 * Close a tab and return the next navigation target (neighbor, or workspace root).
 */
export function closeTabAndPickNext(
  workspaceId: string,
  documentId: string,
  activeDocumentId: string | null,
): { href: string | null; remaining: OpenTabMeta[] } {
  const tabs = readStoredTabs(workspaceId);
  const index = tabs.findIndex((tab) => tab.id === documentId);
  const remaining = tabs.filter((tab) => tab.id !== documentId);
  writeStoredTabs(workspaceId, remaining);

  if (activeDocumentId !== documentId) {
    return { href: null, remaining };
  }

  const neighbor =
    remaining[Math.min(index, remaining.length - 1)] ??
    remaining[remaining.length - 1] ??
    null;

  return {
    href: neighbor
      ? documentPath(workspaceId, neighbor.id)
      : workspacePath(workspaceId),
    remaining,
  };
}

/**
 * Open-document tab strip with overflow menu for dense multi-doc workspaces.
 */
export function DocumentOpenTabs({
  workspaceId,
  activeDocument,
  revision = 0,
  dirtyDocumentId = null,
  onRequestCloseTab,
  onRequestNavigate,
}: {
  workspaceId: string;
  activeDocument: ListedDocument | null;
  revision?: number;
  /**
   * Only the active editor's known unsaved state. Inactive tabs never invent
   * dirty indicators — we only know human edits for the mounted document.
   */
  dirtyDocumentId?: string | null;
  /** Return false to cancel closing. */
  onRequestCloseTab?: (documentId: string) => boolean | void;
  /** Intercept tab navigation (e.g. dirty guard). Return false to cancel. */
  onRequestNavigate?: (href: string) => boolean | void;
}) {
  const router = useRouter();
  const [tabs, setTabs] = React.useState<OpenTabMeta[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const [stripWidth, setStripWidth] = React.useState(0);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const overflowAnchorRef = React.useRef<HTMLButtonElement>(null);
  const overflowMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const stored = readStoredTabs(workspaceId);
    if (!activeDocument) {
      setTabs(stored);
      return;
    }
    const current: OpenTabMeta = {
      id: activeDocument.id,
      name: activeDocument.name,
      format: activeDocument.format,
    };
    const without = stored.filter((tab) => tab.id !== activeDocument.id);
    const next = [...without, current];
    setTabs(next);
    writeStoredTabs(workspaceId, next);
  }, [workspaceId, activeDocument, revision]);

  React.useEffect(() => {
    const node = stripRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setStripWidth(width);
    });
    observer.observe(node);
    setStripWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    setOverflowOpen(false);
  }, [activeDocument?.id, tabs.length]);

  React.useEffect(() => {
    if (!overflowOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOverflowOpen(false);
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (overflowMenuRef.current?.contains(target)) return;
      if (overflowAnchorRef.current?.contains(target)) return;
      setOverflowOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [overflowOpen]);

  const { visible, overflow } = React.useMemo(() => {
    const availableWidth = stripWidth > 0 ? stripWidth : 720;
    return partitionTabsForOverflow(tabs, {
      activeId: activeDocument?.id ?? null,
      availableWidth,
      openButtonWidth: OPEN_BUTTON_WIDTH,
      overflowButtonWidth: OVERFLOW_BUTTON_WIDTH,
      minTabWidth: TAB_MIN_WIDTH,
      maxTabWidth: TAB_MAX_WIDTH,
      estimateTabWidth: (tab) =>
        estimateDocumentTabWidth({
          name: tab.name,
          dirty: dirtyDocumentId === tab.id,
        }),
    });
  }, [tabs, activeDocument?.id, stripWidth, dirtyDocumentId]);

  function closeTab(event: React.MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    if (onRequestCloseTab?.(id) === false) return;

    const { href, remaining } = closeTabAndPickNext(
      workspaceId,
      id,
      activeDocument?.id ?? null,
    );
    setTabs(remaining);
    setOverflowOpen(false);
    if (href) {
      if (onRequestNavigate?.(href) === false) return;
      router.push(href);
    }
  }

  function navigateToTab(event: React.MouseEvent, href: string) {
    if (onRequestNavigate) {
      event.preventDefault();
      if (onRequestNavigate(href) === false) return;
      router.push(href);
    }
  }

  function openTab(href: string) {
    setOverflowOpen(false);
    if (onRequestNavigate?.(href) === false) return;
    router.push(href);
  }

  return (
    <>
      <div
        ref={stripRef}
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-sidebar px-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          {visible.map((tab) => {
            const active = activeDocument?.id === tab.id;
            const dirty = dirtyDocumentId === tab.id;
            const href = documentPath(workspaceId, tab.id);
            return (
              <Link
                key={tab.id}
                href={href}
                title={dirty ? `${tab.name} (unsaved changes)` : tab.name}
                prefetch
                aria-current={active ? "page" : undefined}
                onClick={(event) => navigateToTab(event, href)}
                className={cn(
                  "group relative flex h-7 min-w-[120px] max-w-[176px] shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-[length:var(--text-xs)] transition-colors",
                  active
                    ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(16,24,40,0.06)] ring-1 ring-line"
                    : "text-ink-soft hover:bg-hover hover:text-ink",
                )}
              >
                {dirty ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    title="Unsaved changes"
                    aria-label="Unsaved changes"
                  />
                ) : null}
                <span
                  className={cn(
                    "shrink-0 font-mono text-[7.5px] font-medium uppercase tracking-[0.04em]",
                    active ? "text-ink-soft" : "text-ink-faint",
                  )}
                >
                  {formatLabel(tab.format)}
                </span>
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                <button
                  type="button"
                  title="Close"
                  aria-label={`Close ${tab.name}`}
                  onClick={(event) => closeTab(event, tab.id)}
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[12px] leading-none text-ink-faint hover:bg-sunken hover:text-ink",
                    active
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  )}
                >
                  ×
                </button>
              </Link>
            );
          })}
        </div>

        {overflow.length > 0 ? (
          <div className="relative shrink-0">
            <Button
              ref={overflowAnchorRef}
              type="button"
              variant="ghost"
              size="icon"
              title={`${overflow.length} more open files`}
              aria-label={`Show ${overflow.length} more open files`}
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              onClick={() => setOverflowOpen((open) => !open)}
              className={cn(
                "text-[length:var(--text-xs)] text-ink-soft",
                overflowOpen && "bg-sunken text-ink",
              )}
            >
              ⋯
              <span className="sr-only">{overflow.length}</span>
            </Button>
            {overflowOpen ? (
              <div
                ref={overflowMenuRef}
                role="menu"
                className="absolute right-0 top-[calc(100%+4px)] z-[var(--z-dropdown)] max-h-[min(320px,60vh)] w-[min(280px,calc(100vw-24px))] overflow-y-auto rounded-[var(--radius-md)] border border-line bg-surface py-1 shadow-[var(--elevation-sm)]"
              >
                <p className="px-3 py-1.5 text-[length:var(--text-2xs)] font-medium uppercase tracking-[0.04em] text-ink-faint">
                  {overflow.length} more
                </p>
                {overflow.map((tab) => {
                  const href = documentPath(workspaceId, tab.id);
                  const active = activeDocument?.id === tab.id;
                  return (
                    <div
                      key={tab.id}
                      role="none"
                      className="flex items-center gap-0.5 px-1"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        title={tab.name}
                        onClick={() => openTab(href)}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[length:var(--text-xs)]",
                          active
                            ? "bg-accent-soft font-medium text-ink"
                            : "text-ink hover:bg-sunken",
                        )}
                      >
                        <span className="shrink-0 font-mono text-[7.5px] uppercase text-ink-faint">
                          {formatLabel(tab.format)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {tab.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Close"
                        aria-label={`Close ${tab.name}`}
                        onClick={(event) => closeTab(event, tab.id)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Open file"
          aria-label="Open file"
          onClick={() => setPickerOpen(true)}
          className="shrink-0 text-[13px] text-ink-faint hover:text-ink"
        >
          ＋
        </Button>
      </div>

      {pickerOpen ? (
        <QuickOpenPicker
          workspaceId={workspaceId}
          onClose={() => setPickerOpen(false)}
          onPick={(doc) => {
            setPickerOpen(false);
            const href = documentPath(workspaceId, doc.id);
            if (onRequestNavigate?.(href) === false) return;
            router.push(href);
          }}
        />
      ) : null}
    </>
  );
}

function QuickOpenPicker({
  workspaceId,
  onClose,
  onPick,
}: {
  workspaceId: string;
  onClose: () => void;
  onPick: (doc: ListedDocument) => void;
}) {
  const [files, setFiles] = React.useState<ListedDocument[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    void listDocuments(workspaceId)
      .then((docs) => {
        if (!cancelled) setFiles(docs);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(userFacingError(err, "Could not load files."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const filtered = (files ?? []).filter((file) => {
    if (!query.trim()) return true;
    return file.name.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <Dialog
      title="Open file"
      onClose={onClose}
      className="max-w-[520px]"
      overlayClassName="items-start pt-[13vh]"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search files in this workspace…"
        className="mb-3 w-full rounded-[var(--radius-md)] border border-line bg-paper px-3 py-2 text-[length:var(--text-sm)] text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-accent/20"
      />
      <div className="-mx-1 max-h-[360px] overflow-y-auto px-1">
        {error ? (
          <p className="px-2 py-3 text-[length:var(--text-xs)] text-danger">
            {error}
          </p>
        ) : null}
        {files === null && !error ? (
          <p className="px-2 py-3 text-[length:var(--text-xs)] text-ink-faint">
            Loading…
          </p>
        ) : null}
        {filtered.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => onPick(file)}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left hover:bg-sunken"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-paper font-mono text-[7.5px] text-ink-soft">
              {formatLabel(file.format)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-xs)] font-medium text-ink">
              {file.name}
            </span>
          </button>
        ))}
        {files !== null && filtered.length === 0 ? (
          <p className="px-2 py-3 text-[length:var(--text-xs)] text-ink-faint">
            No matching files.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
