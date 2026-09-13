"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { PageError } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";
import {
  filterManagedModels,
  managedModelMetaLine,
  type ManagedAiModel,
} from "@/lib/ai-settings-model";

/**
 * Searchable managed-model picker — keeps the list out of a giant native select.
 */
export function ManagedModelPicker({
  models,
  value,
  onChange,
  disabled,
  unavailableId,
}: {
  readonly models: readonly ManagedAiModel[];
  readonly value: string | null;
  readonly onChange: (modelId: string) => void;
  readonly disabled?: boolean;
  /** Saved id missing from live catalog — shown until user picks another. */
  readonly unavailableId?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const selected = models.find((model) => model.id === value) ?? null;
  const filtered = React.useMemo(
    () => filterManagedModels(models, query),
    [models, query],
  );

  React.useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2.5 text-left transition-colors",
          "hover:border-ink-faint disabled:opacity-50",
          open && "border-accent ring-2 ring-accent/20",
        )}
      >
        <span className="min-w-0 flex-1">
          {selected ? (
            <>
              <span className="block truncate text-[13px] font-medium text-ink">
                {selected.name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                {managedModelMetaLine(selected) || selected.id}
              </span>
            </>
          ) : unavailableId ? (
            <>
              <span className="block truncate text-[13px] font-medium text-danger">
                Model unavailable
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-faint">
                {unavailableId}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-ink-faint">Choose a model…</span>
          )}
        </span>
        <span className="mt-0.5 shrink-0 text-[11px] text-ink-faint">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-[var(--z-dropdown)] overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface shadow-[var(--elevation-sm)]">
          <div className="border-b border-line p-2">
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="h-8"
            />
          </div>
          <ul
            role="listbox"
            className="max-h-[280px] overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12px] text-ink-faint">
                No models match
              </li>
            ) : (
              filtered.map((model) => {
                const active = model.id === value;
                return (
                  <li key={model.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-primary-soft",
                        active && "bg-accent-soft",
                      )}
                      onClick={() => {
                        onChange(model.id);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="w-full truncate text-[12.5px] font-medium text-ink">
                        {model.name}
                      </span>
                      <span className="w-full truncate text-[11px] text-ink-faint">
                        {managedModelMetaLine(model) || model.id}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ManagedModelPickerError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return <PageError message={message} onRetry={onRetry} />;
}
