import type { DocxLineSpacing, DocxParagraphProperty, DocxTextFormattingProperty } from "./docx-engine-binding.js";

export interface DocxStyleOperation {
  styleId: string; styleType: 'paragraph' | 'character'; name?: string; basedOn?: string; next?: string;
  bold?: boolean;
  italic?: boolean;
  fontSizeHalfPoints?: number;
  fontFamily?: string;
  color?: string;
  underline?: boolean;
  highlight?: string;
  strikethrough?: boolean;
  verticalAlignment?: "baseline" | "superscript" | "subscript";
  lineSpacing?: DocxLineSpacing;
  alignment?: 'left' | 'center' | 'right' | 'both' | 'distribute';
  spacingBeforeTwips?: number;
  spacingAfterTwips?: number;
  leftIndentTwips?: number;
  rightIndentTwips?: number;
  firstLineIndentTwips?: number;
  hangingIndentTwips?: number;
  keepWithNext?: boolean;
  keepLines?: boolean;
  clear?: Array<DocxParagraphProperty | 'basedOn' | 'next' | DocxTextFormattingProperty>;
  baseRevision?: string;
}

export type DocxCreateStyleOperation = DocxStyleOperation & { name: string };
