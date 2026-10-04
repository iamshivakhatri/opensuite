import type { DocxTextTarget } from "./docx-engine-binding.js";
/** Read-only revisions in the main document; includes table paragraphs, excludes other parts. */
export interface DocxRevisionOptions { offset?: number; limit?: number }
export interface DocxRevision {
  index: number; id: string | null; kind: "insertion" | "deletion" | "unsupported";
  author: string | null; date: string | null; text: string | null; paragraphIndex: number | null;
  structure: "supported" | "malformed" | "unsupported"; truncated: boolean; diagnostics: string[];
}
export interface DocxRevisionInspection {
  ok: boolean; total: number; insertionCount: number; deletionCount: number; unsupportedCount: number;
  offset: number; hasMore: boolean; revisions: DocxRevision[];
  diagnostics: { code: string; message: string }[];
}

/** Date defaults to current UTC in engine-client. Targets are fresh exact current text. */
export interface DocxInsertTrackedTextOperation { target: DocxTextTarget; text: string; position?: "before" | "after"; author: string; date?: string }
export interface DocxDeleteTrackedTextOperation { target: DocxTextTarget; author: string; date?: string }
export interface DocxReplaceTextWithTrackedChangeOperation { target: DocxTextTarget; replacement: string; author: string; date?: string }
