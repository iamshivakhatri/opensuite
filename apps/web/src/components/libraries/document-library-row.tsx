"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import type { DocumentFormat } from "@/lib/api";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

/**
 * Compact document row shared by Home Continue + Recent/Starred libraries.
 * Primary action is opening the document; trailing is optional (e.g. star).
 */
export function DocumentLibraryRow({
  href,
  name,
  format,
  meta,
  trailing,
}: {
  href: string;
  name: string;
  format: DocumentFormat;
  /** Quiet secondary line, e.g. "Workspace · Sep 9". */
  meta: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="group relative flex items-center gap-1">
      <Link
        href={href}
        prefetch
        className={cn(
          focusRingClass,
          "flex min-w-0 flex-1 items-center gap-2.5 px-1 py-2.5 transition-colors hover:bg-primary-soft hover:text-primary",
          trailing ? "pr-10" : undefined,
        )}
      >
        <DocumentFormatIcon format={format} size="md" className="text-ink-soft" />
        <span className="min-w-0 flex-1">
          <span className="os-type-label block truncate font-medium text-ink">
            {name}
          </span>
          <span className="os-type-meta mt-0.5 block truncate text-ink-faint">
            {meta}
          </span>
        </span>
      </Link>
      {trailing ? (
        <div className="absolute right-1 top-1/2 -translate-y-1/2">{trailing}</div>
      ) : null}
    </div>
  );
}
