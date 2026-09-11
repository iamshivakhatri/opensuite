"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import { type ListedDocument } from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";
import { upsertOpenTab, type OpenTabMeta } from "@/lib/open-tabs";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "opensuite.openTabs:";

export type { OpenTabMeta };

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
 * Open-document tab strip. Open/close from the file list + each tab's ×.
 */
export function DocumentOpenTabs({
  workspaceId,
  activeDocument,
  activeDocumentId = null,
  revision = 0,
  dirtyDocumentId = null,
  onRequestCloseTab,
  onRequestNavigate,
}: {
  workspaceId: string;
  activeDocument: ListedDocument | null;
  /**
   * Route identity for highlight. Prefer the URL id so selection
   * does not lag behind a still-loading document fetch.
   */
  activeDocumentId?: string | null;
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
  const selectedId = activeDocumentId ?? activeDocument?.id ?? null;

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
    const next = upsertOpenTab(stored, current);
    setTabs(next);
    if (next !== stored) writeStoredTabs(workspaceId, next);
  }, [
    workspaceId,
    activeDocument?.id,
    activeDocument?.name,
    activeDocument?.format,
    revision,
  ]);

  function closeTab(event: React.MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    if (onRequestCloseTab?.(id) === false) return;

    const { href, remaining } = closeTabAndPickNext(
      workspaceId,
      id,
      selectedId,
    );
    setTabs(remaining);
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

  return (
    <div
      role="navigation"
      aria-label="Open documents"
      className="os-workspace-rail flex items-center bg-sidebar px-1.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:thin]">
        {tabs.map((tab) => {
          const active = selectedId === tab.id;
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
                focusRingClass,
                "group relative flex h-8 min-w-[128px] max-w-[200px] shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-[length:var(--text-sm)] transition-colors",
                active
                  ? "bg-surface font-medium text-ink shadow-[var(--elevation-xs)] ring-1 ring-line"
                  : "text-ink-soft hover:bg-hover hover:text-ink",
              )}
            >
              {dirty ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  title="Unsaved changes"
                  aria-hidden
                />
              ) : null}
              <DocumentFormatIcon
                format={tab.format}
                size="sm"
                className={active ? "text-ink-soft" : "text-ink-faint"}
              />
              <span className="min-w-0 flex-1 truncate">{tab.name}</span>
              <button
                type="button"
                title="Close"
                aria-label={`Close ${tab.name}`}
                onClick={(event) => closeTab(event, tab.id)}
                className={cn(
                  focusRingClass,
                  "grid h-4 w-4 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[length:var(--text-sm)] leading-none text-ink-faint hover:bg-sunken hover:text-ink",
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
    </div>
  );
}
