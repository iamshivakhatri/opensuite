import type { DocxTextTarget } from "./docx-engine-binding.js";
/** Standard Word comments. Replies and resolved state are unavailable. */
export interface DocxCommentOptions { offset?: number; limit?: number }
export interface DocxComment {
  id: string | null; handle: string | null; author: string | null; initials: string | null; date: string | null;
  text: string; anchoredText: string | null; paragraphIndex: number | null; endParagraphIndex: number | null;
  hasRange: boolean; hasReference: boolean; structure: "range" | "point" | "orphaned" | "malformed"; truncated: boolean;
}
export interface DocxCommentInspection {
  ok: boolean; comments: DocxComment[]; total: number; offset: number; hasMore: boolean;
  diagnostics: { code: string; message: string }[];
}
export interface DocxAddCommentOperation {
  target: DocxTextTarget; text: string; author: string; initials?: string;
  /** ISO timestamp; omitted uses the caller runtime's current UTC time. */
  date?: string;
}
export interface DocxUpdateCommentOperation { handle: string; text: string }
export interface DocxDeleteCommentOperation { handle: string }
