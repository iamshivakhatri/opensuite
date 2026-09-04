import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatBytes, formatLabel } from "@/components/files/format";
import type { ListedDocument } from "@/lib/api";

/**
 * Compact, document-focused header for the workspace shell. Replaces the
 * general app topbar for this route.
 */
export function DocumentHeader({
  document,
  downloading,
  onDownload,
}: {
  document: ListedDocument;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <header
      className="flex h-[48px] shrink-0 items-center gap-3 border-b border-[#E2E5EA] px-3.5 backdrop-saturate-150"
      style={{
        background: "rgba(250,250,252,0.86)",
        backdropFilter: "blur(18px) saturate(1.18)",
      }}
    >
      <Link
        href="/app"
        className="shrink-0 text-[10.5px] font-medium text-[#969BA5] hover:text-ink"
      >
        ← All Files
      </Link>
      <div className="h-3.5 w-px shrink-0 bg-[#E2E5EA]" />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[11.5px] font-semibold text-[#1C1F24]">
          {document.name}
        </span>
        <span className="shrink-0 rounded-full border border-[#E0E3E8] bg-white px-[6px] py-[2px] font-mono text-[7.5px] font-medium text-[#8F949E]">
          {formatLabel(document.format)}
        </span>
      </div>
      <div className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
        Version {document.latestVersion.versionNumber} ·{" "}
        {formatBytes(document.latestVersion.sizeBytes)}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-[30px] shrink-0 rounded-[9px] border-[#E0E3E8] px-[10px] text-[11px]"
        disabled={downloading}
        onClick={onDownload}
      >
        {downloading ? "Downloading…" : "Download"}
      </Button>
    </header>
  );
}
