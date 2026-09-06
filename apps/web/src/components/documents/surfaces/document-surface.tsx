"use client";

import type { ListedDocument } from "@/lib/api";
import {
  DocxSurface,
  type DocxSurfaceStatus,
} from "@/components/documents/surfaces/docx-surface";
import { OfficePlaceholderSurface } from "@/components/documents/surfaces/office-placeholder-surface";

/**
 * Format boundary for the center document area.
 * Only DOCX is a real Casual Docs surface; PPTX/XLSX stay placeholders.
 */
export function DocumentSurface({
  document,
  onStatusChange,
  onDocumentUpdated,
  saveRequestId,
}: {
  readonly document: ListedDocument;
  readonly onStatusChange?: (status: DocxSurfaceStatus) => void;
  readonly onDocumentUpdated?: (document: ListedDocument) => void;
  readonly saveRequestId?: number;
}) {
  switch (document.format) {
    case "docx":
      return (
        <DocxSurface
          document={document}
          onStatusChange={onStatusChange}
          onDocumentUpdated={onDocumentUpdated}
          saveRequestId={saveRequestId}
        />
      );
    case "pptx":
    case "xlsx":
      return <OfficePlaceholderSurface format={document.format} />;
    default:
      return <OfficePlaceholderSurface format="pptx" />;
  }
}
