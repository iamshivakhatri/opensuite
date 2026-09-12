"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import {
  focusRingClass,
  getFocusableElements,
  handleMenuRovingKeys,
  useFocusScope,
} from "@/lib/focus-scope";
import { useModalLayer } from "@/lib/use-modal-layer";
import { cn } from "@/lib/utils";

export type ContextMenuItem = {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};

/**
 * Lightweight anchored context menu — Escape / outside click to close,
 * arrow-key roving focus, restores focus to the anchor.
 */
export function ContextMenu({
  open,
  onClose,
  anchorRef,
  items,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  items: readonly ContextMenuItem[];
}) {
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(
    null,
  );

  React.useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPos(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const width = 176;
    const estimatedHeight = Math.min(items.length * 32 + 8, 280);
    let left = Math.min(rect.right - width, window.innerWidth - width - 8);
    left = Math.max(8, left);
    let top = rect.bottom + 4;
    if (top + estimatedHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - 4);
    }
    setPos({ top, left });
  }, [open, anchorRef, items.length]);

  React.useEffect(() => {
    if (!open || !pos) return;
    const menu = menuRef.current;
    if (!menu) return;
    const focusables = getFocusableElements(menu);
    focusables[0]?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (menu && handleMenuRovingKeys(event, menu)) return;
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
      anchorRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, pos, onClose, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[var(--z-popover)] min-w-[176px] overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface py-1 shadow-[var(--elevation-sm)]"
      style={{ top: pos.top, left: pos.left }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={cn(
            focusRingClass,
            "os-type-label block w-full px-3 py-1.5 text-left disabled:opacity-40",
            item.danger
              ? "text-danger hover:bg-danger-soft"
              : "text-ink hover:bg-sunken",
          )}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  error,
  className,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  /** Optional panel class — e.g. wider / danger-bordered for high-impact confirms. */
  className?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = React.useState(false);
  useFocusScope(true, panelRef);
  useModalLayer(true);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay px-4 backdrop-blur-[6px]"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "w-full max-w-[380px] rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--elevation-md)]",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id={titleId}
          className="mb-3 text-[length:var(--text-md)] font-semibold tracking-[-0.02em] text-ink"
        >
          {title}
        </h2>
        <div className="os-type-secondary mb-4 text-ink-soft">{body}</div>
        {error ? <p className="os-type-meta mb-3 text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 font-medium text-ink-soft hover:text-ink",
            )}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-danger px-3 font-medium text-on-ink hover:opacity-90 disabled:opacity-50",
            )}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function PromptDialog({
  title,
  label,
  initialValue,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  title: string;
  label?: string;
  initialValue: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = React.useState(initialValue);
  const panelRef = React.useRef<HTMLFormElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const titleId = React.useId();
  const inputId = React.useId();
  const [mounted, setMounted] = React.useState(false);
  useFocusScope(true, panelRef);
  useModalLayer(true);

  React.useEffect(() => {
    setMounted(true);
  }, []);
  React.useEffect(() => setValue(initialValue), [initialValue]);
  React.useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay px-4 backdrop-blur-[6px]"
      onClick={onCancel}
    >
      <form
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-[380px] rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--elevation-md)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || busy) return;
          onSubmit(value.trim());
        }}
      >
        <h2
          id={titleId}
          className="mb-3 text-[length:var(--text-md)] font-semibold tracking-[-0.02em] text-ink"
        >
          {title}
        </h2>
        {label ? (
          <label
            htmlFor={inputId}
            className="os-type-meta mb-1 block text-ink-faint"
          >
            {label}
          </label>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          value={value}
          maxLength={255}
          onChange={(event) => setValue(event.target.value)}
          className={cn(
            focusRingClass,
            "mb-3 h-9 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[length:var(--text-sm)] text-ink placeholder:text-ink-faint",
          )}
        />
        {error ? <p className="os-type-meta mb-3 text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 font-medium text-ink-soft hover:text-ink",
            )}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className={cn(
              focusRingClass,
              "os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-ink px-3 font-medium text-on-ink disabled:opacity-50",
            )}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
