import type { ListedDocument } from "@/lib/api";
import { formatLabel } from "@/components/files/format";

const futureContextByFormat: Record<ListedDocument["format"], string> = {
  docx: "Outline and pages will appear here.",
  pptx: "Slide thumbnails will appear here.",
  xlsx: "Sheet navigation will appear here.",
};

/**
 * Narrow left region reserved for document-context navigation (DOCX
 * outline, PPTX slide thumbnails, XLSX sheet tabs). Deliberately minimal
 * until per-format engine rendering lands.
 */
export function DocumentNavigationPanel({
  document,
  collapsed,
  onExpand,
}: {
  document: ListedDocument;
  collapsed: boolean;
  onExpand: () => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        title="Show document navigation"
        className="flex h-full w-10 shrink-0 flex-col items-center border-r border-line bg-[#F8F9FB] pt-3"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[9px] text-[13px] text-ink-faint hover:bg-sunken hover:text-ink-soft">
          ›
        </span>
      </button>
    );
  }

  return (
    <aside className="flex h-full w-[208px] shrink-0 flex-col border-r border-line bg-[#F8F9FB]">
      <div className="flex items-center justify-between px-2.5 py-2.5">
        <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-[#9A9FAA]">
          Document
        </span>
        <button
          type="button"
          onClick={onExpand}
          title="Hide document navigation"
          className="grid h-6 w-6 place-items-center rounded-[7px] text-[11px] text-ink-faint hover:bg-sunken hover:text-ink-soft"
        >
          ‹
        </button>
      </div>
      <div className="px-2.5 pb-3">
        <div className="rounded-[11px] border border-[#E5E8ED] bg-white px-2.5 py-2.5 text-[11px] text-ink-soft shadow-[0_1px_2px_rgba(16,24,40,0.025)]">
          <div className="mb-1 font-semibold text-ink">
            {formatLabel(document.format)}
          </div>
          <p className="leading-relaxed text-ink-faint">
            {futureContextByFormat[document.format]}
          </p>
        </div>
      </div>
    </aside>
  );
}
