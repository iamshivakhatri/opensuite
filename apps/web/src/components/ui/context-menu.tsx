"use client";

import * as React from "react";

export type ContextMenuItem = {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};

/**
 * Lightweight anchored context menu — Escape / outside click to close.
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
    const width = 168;
    const left = Math.min(
      rect.right - width,
      window.innerWidth - width - 8,
    );
    setPos({
      top: rect.bottom + 4,
      left: Math.max(8, left),
    });
  }, [open, anchorRef]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
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
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-[10px] border border-line bg-surface py-1 shadow-[0_8px_28px_rgba(15,18,24,0.12)]"
      style={{ top: pos.top, left: pos.left }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={
            "block w-full px-3 py-1.5 text-left text-[11.5px] disabled:opacity-40 " +
            (item.danger
              ? "text-danger hover:bg-danger-soft"
              : "text-ink hover:bg-sunken")
          }
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,18,24,0.32)] px-4 backdrop-blur-[6px]"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[380px] rounded-[16px] border border-line bg-surface p-4 shadow-[0_24px_80px_rgba(15,18,24,0.2)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-[14px] font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h2>
        <div className="mb-4 text-[12px] leading-relaxed text-ink-soft">{body}</div>
        {error ? <p className="mb-3 text-[11px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line bg-surface px-3 text-xs font-medium text-ink-soft hover:text-ink"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-8 items-center rounded-[var(--radius-md)] bg-danger px-3 text-xs font-medium text-white hover:bg-[#B0453A] disabled:opacity-50"
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
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
  React.useEffect(() => setValue(initialValue), [initialValue]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,18,24,0.32)] px-4 backdrop-blur-[6px]"
      onClick={onCancel}
    >
      <form
        className="w-full max-w-[380px] rounded-[16px] border border-line bg-surface p-4 shadow-[0_24px_80px_rgba(15,18,24,0.2)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || busy) return;
          onSubmit(value.trim());
        }}
      >
        <h2 className="mb-3 text-[14px] font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {label ? (
          <label className="mb-1 block text-[10.5px] text-ink-faint">{label}</label>
        ) : null}
        <input
          autoFocus
          value={value}
          maxLength={255}
          onChange={(event) => setValue(event.target.value)}
          className="mb-3 h-9 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[13px] text-ink outline-none focus-visible:border-accent"
        />
        {error ? <p className="mb-3 text-[11px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line bg-surface px-3 text-xs font-medium text-ink-soft hover:text-ink"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="inline-flex h-8 items-center rounded-[var(--radius-md)] bg-ink px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
