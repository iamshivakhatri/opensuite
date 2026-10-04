/** Version 1: reusable formatting facts, never document content or engine handles. */
export interface StyleTextFormatting {
  fontFamily?: string;
  fontSizeHalfPoints?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: string;
  strikethrough?: boolean;
  verticalAlignment?: string;
}
export interface StyleParagraphFormatting {
  alignment?: string;
  spacingBeforeTwips?: number;
  spacingAfterTwips?: number;
  lineSpacing?: { value: number; rule?: string };
  leftIndentTwips?: number;
  rightIndentTwips?: number;
  firstLineIndentTwips?: number;
  hangingIndentTwips?: number;
  keepWithNext?: boolean;
  keepLines?: boolean;
}
export interface StyleRole {
  styleId?: string;
  name?: string;
  text: StyleTextFormatting;
  paragraph: StyleParagraphFormatting;
  evidence: { paragraphCount: number; runCount: number; source: 'defaults' | 'named_style' | 'repeated_body' };
}
export interface StyleProfileData {
  schemaVersion: 1;
  body: StyleRole;
  title?: StyleRole;
  headings: (StyleRole & { level: number })[];
  emphasis: { formatting: StyleTextFormatting; count: number; repeated: boolean }[];
  palette: { text: string[]; headings: string[]; tableFills: string[]; borders: string[] };
  lists: { format: string; text?: string; suffix?: string; leftIndentTwips?: number; hangingIndentTwips?: number; count: number }[];
  table?: {
    sampleCount: number;
    headerFills: string[];
    headerHasBoldText: boolean;
    borders: { side: string; style?: string; color?: string; sizeEighthPoints?: number }[];
    cellMarginsTwips: Record<string, number>;
    widthTwips?: number;
    widthType?: string;
    alignment?: string;
  };
  page?: {
    sampleCount: number;
    pageWidthTwips?: number;
    pageHeightTwips?: number;
    orientation?: string;
    orientationSource: 'explicit' | 'unknown';
    marginsTwips: Record<string, number>;
    differentFirstPage: boolean;
    oddEvenHeaders: boolean;
    pageNumberStart?: number;
    pageNumberFormat?: string;
  };
  headersFooters: {
    present: boolean;
    variants: { kind: 'header' | 'footer'; variant: string; hasPageNumber: boolean; fonts: string[]; textColors: string[]; styleIds: string[] }[];
  };
  diagnostics: { code: string; message: string }[];
  unresolvedThemeReferences: { property: string; value: string; count: number }[];
  evidence: { paragraphCount: number; runCount: number; tableCount: number; truncated: boolean };
}
export interface StyleProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: {
    type: 'docx';
    documentId: string;
    versionId: string;
    workspaceId: string;
    fileName: string;
    extractedAt: string;
    snapshotSchemaVersion: 1;
    normalizerVersion: 1;
  };
  style: StyleProfileData;
}
