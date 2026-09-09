"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared modal dialog shell — overlay + centered card + Escape-to-close.
 * Replaces the duplicated Modal/Dialog shells in shell + workspaces surfaces.
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
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay px-4 backdrop-blur-[6px]",
        overlayClassName,
      )}
      onClick={closeOnOverlayClick ? onClose : undefined}
    >
      <div
        className={cn(
          "w-full max-w-[380px] rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--elevation-md)]",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="mb-3 text-[14px] font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
