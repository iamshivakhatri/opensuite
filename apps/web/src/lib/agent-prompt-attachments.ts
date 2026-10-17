export type ChatAttachmentRef = {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly status: "staged" | "bound" | "deleted";
};

export type PromptAttachmentStatus = "pending" | "uploading" | "ready" | "error";

export type PromptAttachment = {
  readonly localId: string;
  readonly file: File;
  status: PromptAttachmentStatus;
  attachment?: ChatAttachmentRef;
  error?: string;
};

const SUPPORTED_EXT =
  /\.(docx|pdf|txt|md|markdown|png|jpe?g)$/i;

export const CHAT_ATTACHMENT_ACCEPT =
  ".docx,.pdf,.txt,.md,.markdown,.png,.jpg,.jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain,text/markdown,image/png,image/jpeg";

export function isSupportedChatAttachment(file: File): boolean {
  return SUPPORTED_EXT.test(file.name);
}

export function isImageAttachmentName(name: string): boolean {
  return /\.(png|jpe?g)$/i.test(name);
}

/**
 * Image files from a paste event, named for the chat-attachment upload flow.
 * Returns none when the clipboard also carries text (e.g. cells copied from a
 * spreadsheet), so ordinary text paste is never intercepted. Unsupported image
 * types keep their own extension so the normal validation rejects them.
 */
export function pastedImageFiles(
  data: Pick<DataTransfer, "items" | "getData"> | null,
  now: Date = new Date(),
): File[] {
  if (!data || data.getData("text/plain")) return [];
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const blobs = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((blob): blob is File => blob !== null);
  return blobs.map((blob, index) => {
    const subtype = blob.type.slice("image/".length).replace(/[^a-z0-9].*$/i, "");
    const ext = subtype === "jpeg" ? "jpg" : subtype || "img";
    const suffix = index === 0 ? "" : `-${index + 1}`;
    return new File([blob], `pasted-image-${stamp}${suffix}.${ext}`, {
      type: blob.type,
      lastModified: now.getTime(),
    });
  });
}

export function addPromptAttachmentFiles(
  current: readonly PromptAttachment[],
  files: readonly File[],
): { items: PromptAttachment[]; rejected: boolean } {
  const next = [...current];
  let rejected = false;
  for (const file of files) {
    if (!isSupportedChatAttachment(file)) {
      rejected = true;
      continue;
    }
    if (
      next.some(
        (item) =>
          item.file.name === file.name &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified,
      )
    ) {
      continue;
    }
    next.push({
      localId: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
      file,
      status: "pending",
    });
  }
  return { items: next, rejected };
}

export function attachmentIdsReady(
  attachments: readonly PromptAttachment[],
): string[] | null {
  if (attachments.some((item) => item.status === "pending" || item.status === "uploading")) {
    return null;
  }
  if (attachments.some((item) => item.status === "error" || !item.attachment)) {
    return null;
  }
  return attachments.map((item) => item.attachment!.id);
}

export function hasPendingUploads(attachments: readonly PromptAttachment[]): boolean {
  return attachments.some(
    (item) => item.status === "pending" || item.status === "uploading",
  );
}

/**
 * Upload pending/error attachments. Ready IDs are reused (no re-upload).
 * Mutates status on each item via onUpdate.
 */
export async function uploadPromptAttachments(
  workspaceId: string,
  attachments: readonly PromptAttachment[],
  upload: (
    workspaceId: string,
    file: File,
    options?: { threadId?: string },
  ) => Promise<{ attachment: ChatAttachmentRef }>,
  onUpdate: (localId: string, patch: Partial<PromptAttachment>) => void,
  options?: { threadId?: string },
): Promise<string[]> {
  const ids: string[] = [];
  for (const item of attachments) {
    if (item.attachment && item.status === "ready") {
      ids.push(item.attachment.id);
      continue;
    }
    onUpdate(item.localId, { status: "uploading", error: undefined });
    try {
      const { attachment } = await upload(workspaceId, item.file, options);
      onUpdate(item.localId, {
        status: "ready",
        attachment,
        error: undefined,
      });
      ids.push(attachment.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Upload failed";
      onUpdate(item.localId, { status: "error", error: message });
      throw error;
    }
  }
  return ids;
}
