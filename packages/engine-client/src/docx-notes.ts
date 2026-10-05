import type { DocxTextTarget } from "./docx-engine-binding.js";
export type DocxNoteKind = "footnote" | "endnote";
export interface DocxNoteOptions { offset?: number; limit?: number }
export interface DocxNote {
  kind: DocxNoteKind; id: number | null; handle: string | null; text: string;
  paragraphIndex: number | null; referenceIndex: number | null; referenceCount: number;
  structure: "supported" | "unsupported" | "malformed"; truncated: boolean;
}
export interface DocxNoteSettings {
  kind: DocxNoteKind; partName: string; sectionIndex: number | null;
  numberFormat: string | null; restart: string | null; position: string | null; start: string | null;
}
export interface DocxNoteInspection {
  ok: boolean; notes: DocxNote[]; total: number; footnoteCount: number; endnoteCount: number;
  unsupportedCount: number; offset: number; hasMore: boolean; settings: DocxNoteSettings[];
  diagnostics: { code: string; message: string }[];
}
/** Place a reference immediately after exact ordinary body text. */
export interface DocxInsertNoteOperation { kind: DocxNoteKind; target: DocxTextTarget; text: string }
export interface DocxUpdateNoteOperation { handle: string; text: string }
export interface DocxDeleteNoteOperation { handle: string }
