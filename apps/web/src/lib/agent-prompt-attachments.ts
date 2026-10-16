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
