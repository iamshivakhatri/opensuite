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
  viewVersionId = null,
  onStatusChange,
  onDocumentUpdated,
  onRequestRestore,
  saveRequestId,
  workingPreview,
}: {
  readonly document: ListedDocument;
  readonly viewVersionId?: string | null;
  readonly onStatusChange?: (status: DocxSurfaceStatus) => void;
  readonly onDocumentUpdated?: (document: ListedDocument) => void;
  readonly onRequestRestore?: () => void;
  readonly saveRequestId?: number;
  readonly workingPreview?: { runId: string; documentId: string; baseVersionId: string; revision: number } | null;
}) {
  switch (document.format) {
    case "docx":
      return (
        <DocxSurface
          document={document}
          viewVersionId={viewVersionId}
          onStatusChange={onStatusChange}
          onDocumentUpdated={onDocumentUpdated}
          onRequestRestore={onRequestRestore}
          saveRequestId={saveRequestId}
          workingPreview={workingPreview}
        />
      );
    case "pptx":
    case "xlsx":
      return <OfficePlaceholderSurface format={document.format} />;
    default:
      return <OfficePlaceholderSurface format="pptx" />;
  }
}
