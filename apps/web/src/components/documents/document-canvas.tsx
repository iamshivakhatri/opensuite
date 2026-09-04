import type { DocumentFormat } from "@/lib/api";
import { formatLabel } from "@/components/files/format";

/**
 * Central document canvas. Geometry hints at the eventual surface (a page,
 * a slide, a workbook) without rendering any real content — engine
 * rendering plugs in here later.
 */
export function DocumentCanvas({ format }: { format: DocumentFormat }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-start justify-center overflow-auto bg-[#ECEEF2] px-9 pb-24 pt-12">
      <div className={surfaceClassName(format)}>
        <div className="mb-3.5 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-[#A0A5AF]">
          {formatLabel(format)} · Preview
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Preview not connected yet.
        </p>
      </div>
    </div>
  );
}

function surfaceClassName(format: DocumentFormat): string {
  const base =
    "grid place-items-center border border-line bg-white text-center shadow-[0_1px_2px_rgba(16,24,40,0.06),0_18px_60px_rgba(16,24,40,0.09)]";

  switch (format) {
    case "docx":
      // Page-shaped: tall, letter-like proportions, close to the reference's 780px page.
      return `${base} aspect-[8.5/11] w-full max-w-[640px] rounded-[3px] px-14 py-16`;
    case "pptx":
      // Slide-shaped: 16:9, rounded like a real slide surface.
      return `${base} aspect-video w-full max-w-[760px] rounded-[18px] px-14 py-12`;
    case "xlsx":
      // Workbook-shaped: wide grid surface.
      return `${base} aspect-[4/3] w-full max-w-[860px] rounded-[10px] px-14 py-16`;
    default:
      return `${base} aspect-[8.5/11] w-full max-w-[640px] rounded-[3px] px-14 py-16`;
  }
}
