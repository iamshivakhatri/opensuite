import type { ListedDocument } from "./api";

export type PromptAttachment = { file: File; document?: ListedDocument };

export async function uploadPromptAttachments(
  workspaceId: string,
  attachments: readonly PromptAttachment[],
  upload: (workspaceId: string, file: File) => Promise<{ document: ListedDocument }>,
  onUploaded: (file: File, document: ListedDocument) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const attachment of attachments) {
    const document = attachment.document ?? (await upload(workspaceId, attachment.file)).document;
    if (!attachment.document) onUploaded(attachment.file, document);
    ids.push(document.id);
  }
  return ids;
}
