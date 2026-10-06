export interface DocxStyleInspectionDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface DocxStyleCountedValue {
  readonly value: string;
  readonly count: number;
}

export interface DocxRunFormattingSnapshot {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
  readonly color?: string;
  readonly underline?: boolean;
  readonly highlight?: string;
  readonly strikethrough?: boolean;
  readonly verticalAlignment?: string;
}

export interface DocxParagraphFormattingSnapshot {
  readonly alignment?: string;
  readonly spacingBeforeTwips?: number;
  readonly spacingAfterTwips?: number;
  readonly lineSpacing?: { readonly value: number; readonly rule?: string };
  readonly leftIndentTwips?: number;
  readonly rightIndentTwips?: number;
  readonly firstLineIndentTwips?: number;
  readonly hangingIndentTwips?: number;
  readonly keepWithNext?: boolean;
  readonly keepLines?: boolean;
  readonly pageBreakBefore?: boolean;
  readonly widowControl?: boolean;
}

export interface DocxStyleUsageSnapshot {
  readonly styleId: string;
  readonly name?: string;
  readonly styleType: "paragraph" | "character";
  readonly basedOnStyleId?: string;
  readonly nextStyleId?: string;
  readonly paragraphUsageCount: number;
  readonly runUsageCount: number;
  readonly declaredRunFormatting: DocxRunFormattingSnapshot;
  readonly declaredParagraphFormatting: DocxParagraphFormattingSnapshot;
  readonly effectiveRunFormatting?: DocxRunFormattingSnapshot;
  readonly effectiveParagraphFormatting?: DocxParagraphFormattingSnapshot;
}

export interface DocxStyleSnapshot {
  readonly ok: boolean;
  readonly schemaVersion: 1;
  readonly paragraphCount: number;
  readonly runCount: number;
  readonly tableCount: number;
  readonly sectionCount: number;
  readonly defaults: {
    readonly defaultParagraphStyleId?: string;
    readonly runFormatting: DocxRunFormattingSnapshot;
    readonly paragraphFormatting: DocxParagraphFormattingSnapshot;
  };
  readonly styles: readonly DocxStyleUsageSnapshot[];
  readonly typography: {
    readonly fonts: readonly DocxStyleCountedValue[];
    readonly fontSizesHalfPoints: readonly DocxStyleCountedValue[];
    readonly textColors: readonly DocxStyleCountedValue[];
    readonly highlights: readonly DocxStyleCountedValue[];
    readonly boldRunCount: number;
    readonly italicRunCount: number;
    readonly underlineRunCount: number;
    readonly runPatterns: readonly {
      readonly paragraphStyleId?: string;
      readonly characterStyleId?: string;
      readonly directFormatting: DocxRunFormattingSnapshot;
      readonly effectiveFormatting?: DocxRunFormattingSnapshot;
      readonly usageCount: number;
    }[];
  };
  readonly paragraphPatterns: readonly {
    readonly styleId?: string;
    readonly styleName?: string;
    readonly directFormatting: DocxParagraphFormattingSnapshot;
    readonly effectiveFormatting?: DocxParagraphFormattingSnapshot;
    readonly usageCount: number;
    readonly locations: readonly string[];
  }[];
  readonly lists: readonly {
    readonly numberingId: number;
    readonly abstractNumberingId?: number;
    readonly level: number;
    readonly format: string;
    readonly start?: number;
    readonly restartAfterLevel?: number;
    readonly text?: string;
    readonly suffix?: string;
    readonly leftIndentTwips?: number;
    readonly hangingIndentTwips?: number;
    readonly usageCount: number;
  }[];
  readonly tables: readonly {
    readonly index: number;
    readonly styleId?: string;
    readonly widthTwips?: number;
    readonly widthType?: string;
    readonly columnWidthsTwips: readonly number[];
    readonly alignment?: string;
    readonly borders: readonly {
      readonly side: string;
      readonly style?: string;
      readonly color?: string;
      readonly sizeEighthPoints?: number;
    }[];
    readonly cellMarginsTwips: Readonly<Record<string, number>>;
    readonly shadingColors: readonly DocxStyleCountedValue[];
    readonly borderColors: readonly DocxStyleCountedValue[];
    readonly mergedCellCount: number;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly firstRowShadingColors: readonly string[];
    readonly firstRowBoldRunCount: number;
    readonly hasComplexStructure: boolean;
  }[];
  readonly sections: readonly {
    readonly index: number;
    readonly sectionType?: string;
    readonly pageWidthTwips?: number;
    readonly pageHeightTwips?: number;
    readonly orientation?: string;
    readonly marginsTwips: Readonly<Record<string, number>>;
    readonly columnCount?: number;
    readonly columnSpacingTwips?: number;
    readonly equalColumnWidth?: boolean;
    readonly differentFirstPage: boolean;
    readonly oddEvenHeaders: boolean;
    readonly pageNumberStart?: number;
    readonly pageNumberFormat?: string;
  }[];
  readonly headersFooters: readonly {
    readonly sectionIndex: number;
    readonly kind: "header" | "footer";
    readonly variant: string;
    readonly paragraphCount: number;
    readonly tableCount: number;
    readonly pictureCount: number;
    readonly hasPageNumber: boolean;
    readonly styleIds: readonly string[];
    readonly fonts: readonly string[];
    readonly textColors: readonly string[];
    readonly hasComplexContent: boolean;
  }[];
  readonly themeReferences: readonly {
    readonly property: string;
    readonly value: string;
    readonly count: number;
  }[];
  readonly truncated: boolean;
  readonly diagnostics: readonly DocxStyleInspectionDiagnostic[];
}

/** Inspect DOCX style facts with the local/native engine without exposing OOXML. */
export async function inspectDocxStyleSnapshot(
  input: Uint8Array,
  binding?: Pick<
    import("./docx-engine-binding.js").DocxEngineBinding,
    "inspectDocxStyleSnapshot"
  >,
): Promise<DocxStyleSnapshot> {
  const engine =
    binding ??
    (await (await import("./docx-engine-binding.js")).createNapiDocxEngineBinding());
  return engine.inspectDocxStyleSnapshot(input);
}
