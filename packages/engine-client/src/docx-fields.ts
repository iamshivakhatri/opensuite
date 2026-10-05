import type { DocxParagraphPlacement } from "./docx-engine-binding.js";
/** Main document and header/footer parts. Paragraph indices are local to each part. */
export interface DocxFieldOptions { offset?: number; limit?: number }
export interface DocxField {
  index: number; kind: "page" | "numPages" | "toc" | "date" | "unknown";
  representation: "simple" | "complex"; instruction: string | null; cachedResult: string | null;
  partName: string; paragraphIndex: number | null; structure: "complete" | "malformed" | "unsupported";
  dirty: boolean | null; locked: boolean | null; headingLevels: [number, number] | null;
  truncated: boolean; diagnostics: string[];
}
export interface DocxFieldInspection {
  ok: boolean; total: number; offset: number; hasMore: boolean; fields: DocxField[];
  diagnostics: { code: string; message: string }[];
}
export type DocxFieldContent = { kind: "text"; text: string } | { kind: "page" } | { kind: "numPages" };
/** New paragraph only. Footer appends to the single-section default footer. */
export type DocxInsertFieldsOperation = { content: readonly DocxFieldContent[] } & (
  { location?: "body"; placement: DocxParagraphPlacement } | { location: "footer"; placement?: never }
);
/** Word calculates the TOC. Default levels 1–3; maximum 9. */
export interface DocxInsertTocOperation { placement: DocxParagraphPlacement; maxHeadingLevel?: number; title?: string }
