import { sanitizeUploadFilename } from "../documents/format.js";

export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 10;
export const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export const CHAT_ATTACHMENT_MEDIA_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
] as const;

export type ChatAttachmentMediaType = (typeof CHAT_ATTACHMENT_MEDIA_TYPES)[number];

const EXT_TO_MEDIA: Record<string, ChatAttachmentMediaType> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

/** Verify extension + light magic/bytes; returns canonical media type. */
export function verifyChatAttachmentBytes(
  filename: string,
  bytes: Buffer,
): { filename: string; mediaType: ChatAttachmentMediaType } | null {
  const safe = sanitizeUploadFilename(filename);
  if (!safe) return null;
  const mediaType = EXT_TO_MEDIA[extensionOf(safe)];
  if (!mediaType) return null;
  if (bytes.length === 0) return null;

  if (mediaType.endsWith("wordprocessingml.document")) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  } else if (mediaType === "application/pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return null;
  } else if (mediaType === "image/png") {
    if (
      bytes.length < 8 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
      return null;
    }
  } else if (mediaType === "image/jpeg") {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return null;
    }
  } else if (mediaType === "text/plain" || mediaType === "text/markdown") {
    // Reject obvious binary (NUL in the first 8 KiB).
    const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
    if (sample.includes(0)) return null;
  }

  return { filename: safe, mediaType };
}
