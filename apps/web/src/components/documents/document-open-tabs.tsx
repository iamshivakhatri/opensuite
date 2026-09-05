"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { formatLabel, userFacingError } from "@/components/files/format";
import { listDocuments, type ListedDocument } from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";

const STORAGE_PREFIX = "opensuite.openTabs:";

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
 * Open-document tab strip. ＋ opens a file picker (does not leave the workspace).
 */
export function DocumentOpenTabs({
  workspaceId,
  activeDocument,
}: {
  workspaceId: string;
  activeDocument: ListedDocument | null;
}) {
  const router = useRouter();
  const [tabs, setTabs] = React.useState<OpenTabMeta[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);

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
  }, [workspaceId, activeDocument]);

  function closeTab(event: React.MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    const { href, remaining } = closeTabAndPickNext(
      workspaceId,
      id,
      activeDocument?.id ?? null,
    );
    setTabs(remaining);
    if (href) router.push(href);
  }

  return (
    <>
      <div className="flex h-[38px] shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-line bg-[var(--sidebar)] px-1.5 [scrollbar-width:thin]">
        {tabs.map((tab) => {
          const active = activeDocument?.id === tab.id;
          return (
            <Link
              key={tab.id}
              href={documentPath(workspaceId, tab.id)}
              title={tab.name}
              className={
                "group relative flex h-full max-w-[200px] min-w-[112px] items-center gap-1.5 border-x border-t px-2 text-[11px] " +
                (active
                  ? "rounded-[8px_8px_0_0] border-line border-b-surface bg-surface font-medium text-ink"
                  : "rounded-[8px_8px_0_0] border-transparent text-ink-soft hover:bg-sunken/70 hover:text-ink")
              }
            >
              <span className="shrink-0 font-mono text-[7.5px] uppercase text-ink-faint">
                {formatLabel(tab.format)}
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.name}</span>
              <button
                type="button"
                title="Close"
                onClick={(event) => closeTab(event, tab.id)}
                className={
                  "grid h-4 w-4 shrink-0 place-items-center rounded text-[11px] text-ink-faint hover:bg-sunken hover:text-ink " +
                  (active ? "opacity-100" : "opacity-0 group-hover:opacity-100")
                }
              >
                ×
              </button>
            </Link>
          );
        })}
        <button
          type="button"
          title="Open file"
          onClick={() => setPickerOpen(true)}
          className="mb-0.5 ml-0.5 grid h-7 w-7 shrink-0 place-items-center self-center rounded-[6px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink"
        >
          ＋
        </button>
      </div>

      {pickerOpen ? (
        <QuickOpenPicker
          workspaceId={workspaceId}
          onClose={() => setPickerOpen(false)}
          onPick={(doc) => {
            setPickerOpen(false);
            router.push(documentPath(workspaceId, doc.id));
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

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = (files ?? []).filter((file) => {
    if (!query.trim()) return true;
    return file.name.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(15,18,24,0.3)] pt-[13vh] backdrop-blur-[6px]"
      onClick={onClose}
    >
      <div
        className="w-[min(520px,calc(100vw-28px))] overflow-hidden rounded-[16px] border border-line bg-surface shadow-[0_28px_100px_rgba(15,18,24,0.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Open a file in this workspace…"
            className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {error ? (
            <p className="px-2 py-3 text-[11px] text-danger">{error}</p>
          ) : null}
          {files === null && !error ? (
            <p className="px-2 py-3 text-[11px] text-ink-faint">Loading…</p>
          ) : null}
          {filtered.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => onPick(file)}
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-sunken"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] font-mono text-[7.5px] text-ink-soft">
                {formatLabel(file.format)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink">
                {file.name}
              </span>
            </button>
          ))}
          {files !== null && filtered.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-ink-faint">
              No matching files.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
