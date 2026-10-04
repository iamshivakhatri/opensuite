import type { DocxParagraphFormattingSnapshot, DocxStyleInspectionDiagnostic } from "./docx-style-snapshot.js";
export interface DocxLayoutOptions { blockOffset?: number; blockLimit?: number; sectionIndex?: number }
export interface DocxLayoutSection {
  index: number; handle: string; sectionType?: string; pageWidthTwips?: number; pageHeightTwips?: number;
  orientation?: string; marginsTwips: Record<string, number>; columnCount?: number;
  columnSpacingTwips?: number; equalColumnWidth?: boolean; columnWidthsTwips: (number | null)[];
  differentFirstPage: boolean; oddEvenHeaders: boolean; pageNumberStart?: number; pageNumberFormat?: string;
  usableWidthTwips: number | null; usableHeightTwips: number | null;
}
export interface DocxLayoutSnapshot {
  ok: boolean; schemaVersion: 1; kind: "structural";
  sectionCount: number; blockCount: number; paragraphCount: number; tableCount: number; imageCount: number;
  explicitPageBreakCount: number; sectionBreakCount: number;
  sections: DocxLayoutSection[];
  paragraphPatterns: { formatting: DocxParagraphFormattingSnapshot; count: number }[];
  tables: { handle: string; sectionIndex: number | null; preferredWidth: number | null; preferredWidthType: string | null;
    columnWidthsTwips: number[]; rowCount: number; cellMarginsTwips: Record<string, number>; cannotSplitRowCount: number;
    rows: { index: number; heightTwips: number | null; heightRule: string | null; cannotSplit: boolean | null }[];
    truncated: boolean; hasComplexStructure: boolean }[];
  images: { kind: "inline" | "anchored"; blockHandle: string | null; sectionIndex: number | null;
    relationshipId: string | null; assetPartName: string | null; displayWidthEmu: number | null; displayHeightEmu: number | null;
    intrinsicWidthPixels: number | null; intrinsicHeightPixels: number | null }[];
  blocks: { handle: string; kind: "paragraph" | "table"; sectionIndex: number | null;
    paragraphFormatting: DocxParagraphFormattingSnapshot | null; explicitPageBreakCount: number }[];
  matchingBlockCount: number; blockOffset: number; hasMoreBlocks: boolean; truncated: boolean;
  renderedPageCount: null; renderedLayoutStatus: "unavailable"; diagnostics: DocxStyleInspectionDiagnostic[];
}
