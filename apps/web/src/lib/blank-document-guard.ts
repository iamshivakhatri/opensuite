import type { ListedDocument } from "@/lib/api";

/** Default name from blank DOCX create (apps/api documents service). */
const DEFAULT_BLANK_BASE = "untitled document";

/**
 * A blank DOCX that was never renamed and never got a newer version.
 * Used to stop spam-creating empty files from the explorer +.
 *
 * ponytail: unsaved editor edits don't unlock another blank until save
 * bumps versionNumber — upgrade via dirty-state from the open surface if needed.
 */
export function isPristineBlankDocument(doc: ListedDocument): boolean {
  if (doc.format !== "docx") return false;
  if (doc.latestVersion.versionNumber !== 1) return false;
  const base = doc.name.replace(/\.docx$/i, "").trim().toLowerCase();
  return base === DEFAULT_BLANK_BASE;
}

/** First unused blank in the list, if any. */
export function findPristineBlankDocument(
  documents: readonly ListedDocument[],
): ListedDocument | null {
  return documents.find(isPristineBlankDocument) ?? null;
}

export function canCreateBlankDocument(
  documents: readonly ListedDocument[],
): boolean {
  return findPristineBlankDocument(documents) === null;
}
