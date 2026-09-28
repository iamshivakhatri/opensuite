import { cn } from "@/lib/utils";

/**
 * Public-site mark. Flat ink square with three text rules — the last one
 * short and accented, i.e. the line that was just edited. Deliberately no
 * gradient and no glow; it reads as a document, not an app icon.
 *
 * The workspace shell keeps `BrandMark` / `Wordmark`; this is public chrome.
 */
export function SiteMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect width="24" height="24" rx="4" fill="var(--ink)" />
      <rect x="6" y="7" width="12" height="1.5" rx="0.25" fill="var(--paper)" />
      <rect
        x="6"
        y="11.25"
        width="12"
        height="1.5"
        rx="0.25"
        fill="var(--paper)"
        fillOpacity="0.62"
      />
      <rect
        x="6"
        y="15.5"
        width="6.5"
        height="1.5"
        rx="0.25"
        fill="var(--primary)"
      />
    </svg>
  );
}

export function SiteWordmark({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 text-[15.5px] font-semibold tracking-[-0.028em] text-ink",
        className,
      )}
    >
      <SiteMark className={cn("h-[19px] w-[19px]", markClassName)} />
      OpenSuite
    </span>
  );
}
