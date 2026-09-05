"use client";

/**
 * Shared empty / loading / error blocks for library + IDE surfaces.
 */
export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-faint">
      <span className="inline-block h-3.5 w-3.5 animate-pulse rounded-full bg-ink-faint/35" />
      {label}
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
    <div className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center">
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
    <div className="rounded-[12px] border border-danger/15 bg-danger-soft px-3 py-2.5 text-[12px] text-danger">
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
