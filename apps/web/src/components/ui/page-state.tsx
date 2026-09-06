"use client";

import { cn } from "@/lib/utils";

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[var(--radius-sm)] bg-sunken",
        className,
      )}
    />
  );
}

/**
 * Shared empty / loading / error blocks for library + IDE surfaces.
 */
export function PageLoading({
  label: _label,
  variant = "list",
}: {
  label?: string;
  variant?: "list" | "workspaces" | "settings" | "inline";
}) {
  if (variant === "inline") {
    return (
      <div className="space-y-2" aria-hidden>
        <Bone className="h-3 w-[75%] max-w-[160px]" />
        <Bone className="h-3 w-[45%] max-w-[100px]" />
      </div>
    );
  }

  if (variant === "settings") {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading">
        <Bone className="h-3 w-16" />
        <Bone className="h-4 w-40" />
        <Bone className="mt-2 h-3 w-14" />
        <Bone className="h-4 w-52" />
      </div>
    );
  }

  if (variant === "workspaces") {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-[var(--radius-md)] border border-line bg-surface px-4 py-3.5"
          >
            <div className="mb-2 flex items-center gap-2">
              <Bone className="h-4 w-40" />
              <Bone className="h-3 w-12" />
            </div>
            <Bone className="mb-3 h-3 w-28" />
            <div className="flex gap-1.5">
              <Bone className="h-5 w-24" />
              <Bone className="h-5 w-32" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5"
        >
          <Bone className="h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Bone className="h-3.5 w-[55%]" />
            <Bone className="h-3 w-[35%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PageEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-line px-6 py-14 text-center">
      <p className="text-[13px] font-medium tracking-[-0.01em] text-ink">
        {title}
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">
        {description}
      </p>
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-danger/15 bg-danger-soft px-3 py-2.5 text-[12px] text-danger">
      {message}
      {onRetry ? (
        <button
          type="button"
          className="ml-2 underline underline-offset-2"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
