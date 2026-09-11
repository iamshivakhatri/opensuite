"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { focusRingClass, useFocusScope } from "@/lib/focus-scope";
import { useModalLayer } from "@/lib/use-modal-layer";

/**
 * Shared modal dialog shell — body-portaled overlay + Escape-to-close,
 * initial focus, Tab trap, and focus restore on close.
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
  overlayClassName,
  closeOnOverlayClick = true,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra classes for the panel, e.g. to override the default max width. */
  className?: string;
  /** Extra classes for the overlay (e.g. higher z-index above the command palette). */
  overlayClassName?: string;
  closeOnOverlayClick?: boolean;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const [mounted, setMounted] = React.useState(false);
  useFocusScope(true, panelRef);
  useModalLayer(true);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay px-4 backdrop-blur-[6px]",
        overlayClassName,
      )}
      onClick={closeOnOverlayClick ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className={cn(
          "w-full max-w-[380px] rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--elevation-md)]",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2
          id={titleId}
          className="mb-3 text-[14px] font-semibold tracking-[-0.02em] text-ink"
        >
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
