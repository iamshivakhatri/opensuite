"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ListedDocument } from "@/lib/api";
import { downloadDocument } from "@/lib/api";
import {
  formatBytes,
  formatLabel,
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";

export function FileRow({
  document: doc,
  onError,
}: {
  document: ListedDocument;
  onError: (message: string) => void;
}) {
  const [downloading, setDownloading] = React.useState(false);

  async function handleDownload(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDownloading(true);
    onError("");
    try {
      await downloadDocument(doc.id);
    } catch (error) {
      onError(userFacingError(error, "Could not download this file."));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="grid min-h-[56px] grid-cols-[minmax(200px,1.5fr)_80px_120px_90px_80px] items-center gap-2 border-b border-[#ECEEF1] px-3.5 text-[11px] transition-colors last:border-b-0 hover:bg-[#FAFAFC] max-[900px]:grid-cols-[1fr_88px] max-[900px]:[&>*:nth-child(n+2):nth-child(-n+4)]:hidden">
      <Link
        href={`/app/documents/${doc.id}`}
        className="flex min-w-0 items-center gap-2.5 rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <div className="grid h-[31px] w-[31px] shrink-0 place-items-center rounded-[9px] border border-[#E5E8ED] bg-[#F8F9FB] font-mono text-[7.5px] font-medium text-[#6D7380]">
          {formatLabel(doc.format)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[11.5px] font-semibold text-[#32353B]">
            {doc.name}
          </div>
          <div className="mt-0.5 text-[9.3px] text-[#9A9FAA]">
            Version {doc.latestVersion.versionNumber}
          </div>
        </div>
      </Link>
      <div className="text-[#858B96]">{formatLabel(doc.format)}</div>
      <div className="text-[#858B96]">{formatUpdatedAt(doc.updatedAt)}</div>
      <div className="text-[#858B96]">
        {formatBytes(doc.latestVersion.sizeBytes)}
      </div>
      <div className="justify-self-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-[8px] px-2 text-[9.5px]"
          disabled={downloading}
          onClick={(event) => void handleDownload(event)}
        >
          {downloading ? "…" : "Download"}
        </Button>
      </div>
    </div>
  );
}
