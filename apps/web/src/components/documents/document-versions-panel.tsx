"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { userFacingError } from "@/components/files/format";
import { focusRingClass } from "@/lib/focus-scope";
import { documentVersionsQuery } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

function formatVersionWhen(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diffMs = Date.now() - at;
  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.floor(diffMs / 3_600_000))}h ago`;
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

/**
 * Bottom explorer rail: last ~5 versions of the open document, drawn as a
 * timeline. Selecting a row views that version; editing requires restore (parent).
 */
export function DocumentVersionsPanel({
  documentId,
  selectedVersionId,
  latestVersionId,
  onSelectVersion,
}: {
  documentId: string;
  selectedVersionId: string | null;
  latestVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
}) {
  const versionsQuery = useQuery({
    ...documentVersionsQuery(documentId),
    enabled: Boolean(documentId),
  });
  const versions = versionsQuery.data ?? [];
  const activeId = selectedVersionId ?? latestVersionId;
  const error = versionsQuery.error
    ? userFacingError(versionsQuery.error, "Could not load versions.")
    : null;
  const listLoading = versionsQuery.isPending && versions.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex shrink-0 items-center gap-2 px-3.5 pb-1.5 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
          Versions
        </p>
        {listLoading ? null : (
          <span className="rounded-full bg-ink/5 px-1.5 py-px text-[10.5px] font-medium tabular-nums leading-4 text-ink-faint">
            {versions.length}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
        {error ? (
          <p className="os-type-meta px-1.5 leading-relaxed text-danger">{error}</p>
        ) : null}
        {listLoading ? (
          <div className="flex flex-col gap-2 px-1.5 pt-1" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="os-shimmer h-9 rounded-[var(--radius-md)]"
                style={{ width: `${88 - i * 12}%` }}
              />
            ))}
          </div>
        ) : null}
        {versions.length > 0 ? (
          <ol className="relative flex flex-col gap-0.5">
            {/* Timeline rail, centred on the node column. */}
            <span
              aria-hidden
              className="absolute bottom-4 left-[19px] top-4 w-px bg-line"
            />
            {versions.map((version) => {
              const selected = version.id === activeId;
              const isTip = version.id === latestVersionId;
              return (
                <li key={version.id}>
                  <button
                    type="button"
                    onClick={() => onSelectVersion(version.id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      focusRingClass,
                      "group/version relative flex w-full items-center gap-3 rounded-[var(--radius-md)] border py-1.5 pl-2.5 pr-2.5 text-left transition-colors",
                      selected
                        ? "border-line bg-elevated shadow-[var(--elevation-xs)]"
                        : "border-transparent hover:bg-ink/5",
                    )}
                  >
                    <span className="relative grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
                      <span
                        className={cn(
                          "block rounded-full transition-all",
                          isTip
                            ? "h-2.5 w-2.5 bg-primary ring-[3px] ring-primary-soft"
                            : selected
                              ? "h-2.5 w-2.5 bg-ink-soft ring-[3px] ring-sidebar"
                              : "h-2 w-2 border-[1.5px] border-ink-faint bg-sidebar group-hover/version:border-ink-soft",
                        )}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "text-[length:var(--text-xs)] leading-4",
                            selected ? "font-semibold text-ink" : "font-medium text-ink-soft",
                          )}
                        >
                          Version {version.versionNumber}
                        </span>
                        {isTip ? (
                          <span className="rounded-full bg-primary-soft px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-[0.04em] text-primary">
                            Current
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-[11px] leading-4 text-ink-faint">
                        {formatVersionWhen(version.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
        {!listLoading && !error && versions.length === 0 ? (
          <p className="os-type-meta px-1.5 text-ink-faint">No versions yet</p>
        ) : null}
      </div>
    </div>
  );
}
