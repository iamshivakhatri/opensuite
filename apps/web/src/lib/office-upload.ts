import { uploadDocument, type ListedDocument } from "@/lib/api";

const OFFICE_EXT = /\.(docx|pptx|xlsx)$/i;

export function isOfficeUploadFile(file: File): boolean {
  return OFFICE_EXT.test(file.name);
}

export function filterOfficeUploadFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(isOfficeUploadFile);
}

/**
 * Upload Office files sequentially into a workspace. Reuses existing API.
 */
export async function uploadOfficeFiles(
  workspaceId: string,
  files: File[],
): Promise<{
  uploaded: ListedDocument[];
  rejected: string[];
  errors: string[];
}> {
  const rejected: string[] = [];
  const accepted: File[] = [];
  for (const file of files) {
    if (isOfficeUploadFile(file)) accepted.push(file);
    else rejected.push(file.name);
  }

  const uploaded: ListedDocument[] = [];
  const errors: string[] = [];
  for (const file of accepted) {
    try {
      const result = await uploadDocument(workspaceId, file);
      uploaded.push(result.document);
    } catch (error) {
      errors.push(
        error instanceof Error && error.message
          ? `${file.name}: ${error.message}`
          : `${file.name}: upload failed`,
      );
    }
  }

  return { uploaded, rejected, errors };
}
