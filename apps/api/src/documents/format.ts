export type OfficeFormat = "docx" | "pptx" | "xlsx";

const FORMAT_BY_EXTENSION: Record<string, OfficeFormat> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
};

const CONTENT_TYPE_BY_FORMAT: Record<OfficeFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Strips any path components and returns the basename. Rejects empty / weird names.
 */
export function sanitizeUploadFilename(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }

  // Drop directory components from client-supplied names (path traversal).
  const base = trimmed.split(/[/\\]/).pop()?.trim() ?? "";
  if (!base || base === "." || base === "..") {
    return null;
  }

  // Keep names readable and bounded; reject control characters.
  if (base.length > 255 || /[\0-\x1f\x7f]/.test(base)) {
    return null;
  }

  return base;
}

export function officeFormatFromFilename(
  filename: string,
): OfficeFormat | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return FORMAT_BY_EXTENSION[lower.slice(dot)] ?? null;
}

export function contentTypeForFormat(format: OfficeFormat): string {
  return CONTENT_TYPE_BY_FORMAT[format];
}
