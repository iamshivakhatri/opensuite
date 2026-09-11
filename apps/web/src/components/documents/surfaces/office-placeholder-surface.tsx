"use client";

import type { DocumentFormat } from "@/lib/api";
import { formatLabel } from "@/components/files/format";

/**
 * Honest placeholder for formats without a connected editor yet.
 */
export function OfficePlaceholderSurface({
  format,
}: {
  format: Exclude<DocumentFormat, "docx">;
}) {
  const label =
    format === "pptx"
      ? "Slides editing is not connected yet."
      : "Sheets editing is not connected yet.";

  return (
    <div className="flex h-full min-h-0 flex-1 items-start justify-center overflow-auto bg-canvas px-9 pb-24 pt-12">
      <div className={surfaceClassName(format)}>
        <div className="os-type-section mb-3.5">
          {formatLabel(format)} · Preview
        </div>
        <p className="os-type-secondary text-ink-faint">{label}</p>
      </div>
    </div>
  );
}

function surfaceClassName(format: Exclude<DocumentFormat, "docx">): string {
  const base =
    "grid place-items-center border border-line bg-surface text-center shadow-[var(--elevation-xs),var(--elevation-sm)]";

  if (format === "pptx") {
    return `${base} aspect-video w-full max-w-[760px] rounded-[var(--radius-lg)] px-14 py-12`;
  }
  return `${base} aspect-[4/3] w-full max-w-[860px] rounded-[var(--radius-md)] px-14 py-16`;
}
