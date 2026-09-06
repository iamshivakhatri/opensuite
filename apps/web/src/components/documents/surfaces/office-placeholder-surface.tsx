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
    <div className="flex h-full min-h-0 flex-1 items-start justify-center overflow-auto bg-[#ECEEF2] px-9 pb-24 pt-12">
      <div className={surfaceClassName(format)}>
        <div className="mb-3.5 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-[#A0A5AF]">
          {formatLabel(format)} · Preview
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">{label}</p>
      </div>
    </div>
  );
}

function surfaceClassName(format: Exclude<DocumentFormat, "docx">): string {
  const base =
    "grid place-items-center border border-line bg-white text-center shadow-[0_1px_2px_rgba(16,24,40,0.06),0_18px_60px_rgba(16,24,40,0.09)]";

  if (format === "pptx") {
    return `${base} aspect-video w-full max-w-[760px] rounded-[18px] px-14 py-12`;
  }
  return `${base} aspect-[4/3] w-full max-w-[860px] rounded-[10px] px-14 py-16`;
}
