export interface DocxStyleOperation {
  styleId: string; styleType: 'paragraph' | 'character'; name?: string; basedOn?: string; next?: string;
  bold?: boolean;
  italic?: boolean;
  fontSizeHalfPoints?: number;
  fontFamily?: string;
  color?: string;
  underline?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'both' | 'distribute';
  spacingBeforeTwips?: number;
  spacingAfterTwips?: number;
  leftIndentTwips?: number;
  rightIndentTwips?: number;
  firstLineIndentTwips?: number;
  hangingIndentTwips?: number;
  keepWithNext?: boolean;
  keepLines?: boolean;
  clear?: Array<'basedOn' | 'next' | 'bold' | 'italic' | 'fontSizeHalfPoints' | 'fontFamily' | 'color' | 'underline' | 'alignment' | 'spacingBeforeTwips' | 'spacingAfterTwips' | 'leftIndentTwips' | 'rightIndentTwips' | 'firstLineIndentTwips' | 'hangingIndentTwips' | 'keepWithNext' | 'keepLines'>;
  baseRevision?: string;
}

export type DocxCreateStyleOperation = DocxStyleOperation & { name: string };
