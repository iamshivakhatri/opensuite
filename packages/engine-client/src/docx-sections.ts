import type { DocxEngineDiagnostic, DocxParagraphPlacement } from "./docx-engine-binding.js";

export type DocxSectionBreakType = "nextPage" | "continuous" | "oddPage" | "evenPage";
export interface DocxSectionHeaderFooter {
  readonly kind: "header" | "footer";
  readonly variant: "default" | "first" | "even";
  readonly linkedToPrevious: boolean;
  readonly relationshipId: string | null;
  readonly partName: string | null;
  readonly text: string | null;
  readonly pageNumberAlignment: "left" | "center" | "right" | null;
  readonly supported: boolean;
}
export interface DocxSection {
  readonly handle: string;
  readonly index: number;
  readonly breakType: string;
  readonly pageWidthTwips: number | null;
  readonly pageHeightTwips: number | null;
  readonly orientation: string | null;
  readonly marginsTwips: Readonly<Record<string, number>>;
  readonly columnCount: number | null;
  readonly differentFirstPage: boolean;
  readonly oddEvenHeaders: boolean;
  readonly pageNumberStart: number | null;
  readonly pageNumberFormat: string | null;
  readonly headersFooters: readonly DocxSectionHeaderFooter[];
}
export interface DocxSectionInspection {
  readonly ok: boolean;
  readonly sections: readonly DocxSection[];
  readonly diagnostics: readonly DocxEngineDiagnostic[];
}
export interface DocxInsertSectionBreakOperation {
  readonly placement: DocxParagraphPlacement;
  readonly breakType: DocxSectionBreakType;
}
export interface DocxSetSectionPropertiesOperation {
  readonly handle: string;
  readonly pageSetup?: {
    readonly topMarginTwips?: number;
    readonly bottomMarginTwips?: number;
    readonly leftMarginTwips?: number;
    readonly rightMarginTwips?: number;
    readonly paperSize?: "letter" | "a4";
    readonly orientation?: "portrait" | "landscape";
  };
  readonly differentFirstPage?: boolean;
  readonly breakType?: DocxSectionBreakType;
  readonly pageNumberStart?: number;
  readonly continuePageNumbering?: boolean;
}
export type DocxSetSectionHeaderFooterOperation = {
  readonly handle: string;
  readonly kind: "header" | "footer";
  readonly variant: "default" | "first" | "even";
} & (
  | { readonly action: "inherit" | "unlink" }
  | { readonly action: "text"; readonly text: string }
  | { readonly action: "pageNumber"; readonly alignment?: "left" | "center" | "right" }
);
