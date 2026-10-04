import type { DocxRevisionOptions, DocxRevisionInspection } from "./docx-revisions.js";
import type { DocxCommentOptions, DocxCommentInspection, DocxAddCommentOperation, DocxUpdateCommentOperation, DocxDeleteCommentOperation } from "./docx-comments.js";
/**
 * Narrow Node-binding surface for opensuite-engine N-API.
 *
 * Hides Buffer details from callers. A future HTTP or remote transport can
 * implement the same shape without changing agents.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { DocxSection, DocxSectionInspection, DocxInsertSectionBreakOperation, DocxSetSectionPropertiesOperation, DocxSetSectionHeaderFooterOperation } from "./docx-sections.js";

import type { DocxInsertPictureOperation, DocxSetPictureLayoutOperation, DocxSetPictureSizeOperation, DocxReplacePictureOperation } from "./docx-images.js";
import type { DocxLayoutOptions, DocxLayoutSnapshot } from "./docx-layout.js";
import type { DocxStyleOperation, DocxCreateStyleOperation } from "./docx-styles.js";
import type { DocxStyleSnapshot } from "./docx-style-snapshot.js";

/** Resolved N-API module id: local path when OPENSUITE_ENGINE_PATH is set, else the npm package. */
export function resolveNativeEngineModuleId(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { readonly moduleId: string; readonly fromEnv: boolean } {
  const configured = env.OPENSUITE_ENGINE_PATH?.trim();
  if (!configured) {
    return { moduleId: "@opensuitehq/engine", fromEnv: false };
  }
  const moduleId = isAbsolute(configured)
    ? configured
    : resolve(cwd, configured);
  return { moduleId, fromEnv: true };
}

export interface DocxReplaceTextTarget {
  readonly text: string;
  readonly occurrence?: number;
}

export interface DocxReplaceTextOperation {
  readonly target: DocxReplaceTextTarget;
  readonly expectedCurrentText: string;
  readonly replacement: string;
  readonly baseRevision?: string;
}

export interface DocxEngineDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  /** Engine-authored precise reason; pass through unchanged when present. */
  readonly reasonCode?: string;
  /** Engine operation id that failed (e.g. set_table_cells_text). */
  readonly operation?: string;
  /** Public opaque target handle when the engine supplies one. */
  readonly targetHandle?: string;
  readonly targetType?: string;
  readonly targetDescription?: string;
  readonly updateIndex?: number;
  readonly candidateCount?: number;
  readonly candidateTargets?: readonly string[];
  readonly requiredSelectorKind?: string;
  readonly retryable?: boolean;
  readonly recoveryKind?: string;
}

export interface DocxEngineChange {
  readonly kind: string;
  readonly before: string;
  readonly after: string;
}

export interface DocxEngineOperationResult {
  readonly ok: boolean;
  readonly status: string;
  readonly diagnostics: readonly DocxEngineDiagnostic[];
  readonly changes: readonly DocxEngineChange[];
}

export interface DocxReplaceTextBindingResult {
  readonly result: DocxEngineOperationResult;
  /** Present only on successful verified mutation. */
  readonly output?: Uint8Array;
}

/** Alias — all mutate bindings share the same verified-artifact result shape. */
export type DocxMutationBindingResult = DocxReplaceTextBindingResult;

/** Newer DOCX operations share the same verified-output envelope. */
export type DocxExtendedOperationName =
  | "executeDocxAddComment"
  | "executeDocxUpdateComment"
  | "executeDocxDeleteComment"
  | "executeDocxCreateStyle"
  | "executeDocxUpdateStyle"
  | "executeDocxInsertSectionBreak"
  | "executeDocxSetSectionProperties"
  | "executeDocxSetSectionHeaderFooter"
  | "executeDocxSetOddEvenHeaders"
  | "executeDocxSetTextFormatting"
  | "executeDocxSetContentControlText"
  | "executeDocxSetParagraphsList"
  | "executeDocxSetHyperlink"
  | "executeDocxInsertPicture"
  | "executeDocxDeletePicture"
  | "executeDocxSetPictureSize"
  | "executeDocxSetPictureLayout"
  | "executeDocxReplacePicture"
  | "executeDocxInsertPageBreak"
  | "executeDocxDeletePageBreak"
  | "executeDocxSetPageSetup"
  | "executeDocxSetHeaderFooterText"
  | "executeDocxSetPageNumber"
  | "executeDocxInsertTableRow";

/** Semantic or handle-based table target. */
export interface DocxTableTarget {
  readonly headerCells?: readonly string[];
  readonly occurrence?: number;
  /** Opaque artifact-local table handle from inspect. */
  readonly handle?: string;
}

export interface DocxTableRowAnchor {
  readonly firstCellText?: string;
  readonly occurrence?: number;
  /** Opaque artifact-local row handle from inspect. */
  readonly handle?: string;
}

export type DocxTableCellTarget =
  | {
      readonly handle: string;
    }
  | {
      readonly rowLabel: string;
      readonly columnHeader: string;
      readonly occurrence?: number;
    };

export type DocxTableCellRow =
  | { readonly kind: "header" }
  | { readonly kind: "label"; readonly text: string; readonly occurrence?: number }
  | { readonly kind: "index"; readonly index: number; readonly expectedFirstCellText: string };

export type DocxSemanticCellTarget = DocxTableCellTarget | {
  readonly row: DocxTableCellRow;
  readonly column:
    | { readonly kind: "first" }
    | { readonly kind: "header"; readonly text: string; readonly occurrence?: number }
    | { readonly kind: "index"; readonly index: number; readonly expectedHeaderText: string };
};

export type DocxTableCellTextTarget = DocxSemanticCellTarget;

export interface DocxTableCellUpdate {
  readonly target: DocxSemanticCellTarget;
  readonly expectedCurrentText: string;
  readonly replacement: string;
}

export interface DocxSetTableCellsTextOperation {
  readonly table: DocxTableTarget;
  readonly updates: readonly DocxTableCellUpdate[];
  readonly baseRevision?: string;
}

export interface DocxInsertTableRowsOperation {
  readonly table: DocxTableTarget;
  readonly after: DocxTableRowAnchor;
  readonly rows: readonly (readonly string[])[];
  readonly baseRevision?: string;
}

export interface DocxInsertTableColumnOperation {
  readonly table: DocxTableTarget;
  readonly afterColumnHeader?: string;
  readonly afterColumnHandle?: string;
  readonly header: string;
  readonly cells: readonly string[];
  readonly baseRevision?: string;
}

export interface DocxCreateTableOperation {
  readonly rows: readonly (readonly string[])[];
  readonly placement: DocxParagraphPlacement;
  readonly baseRevision?: string;
}

export interface DocxDeleteTableOperation {
  readonly table: DocxTableTarget;
  readonly baseRevision?: string;
}

export interface DocxDeleteTableRowOperation {
  readonly table: DocxTableTarget;
  readonly row: DocxTableCellRow | DocxTableRowAnchor;
  readonly baseRevision?: string;
}

export interface DocxDeleteTableColumnOperation {
  readonly table: DocxTableTarget;
  readonly columnHeader?: string;
  readonly columnHandle?: string;
  readonly baseRevision?: string;
}

export type DocxTableAlignment = "left" | "center" | "right" | "clear";
export type DocxTableBorders = "grid" | "none" | "clear";

export interface DocxSetTableFormattingOperation {
  readonly table: DocxTableTarget;
  readonly alignment?: DocxTableAlignment;
  readonly cellMarginTopTwips?: number;
  readonly cellMarginRightTwips?: number;
  readonly cellMarginBottomTwips?: number;
  readonly cellMarginLeftTwips?: number;
  readonly borders?: DocxTableBorders;
  readonly baseRevision?: string;
}

export interface DocxSetTableColumnWidthsOperation {
  readonly table: DocxTableTarget;
  readonly widthsTwips: readonly number[];
  readonly baseRevision?: string;
}

export interface DocxSetTableCellShadingOperation {
  readonly table: DocxTableTarget;
  readonly updates: readonly {
    readonly target: DocxSemanticCellTarget;
    /** Omit to clear the cell fill. */
    readonly fill?: string;
  }[];
  readonly baseRevision?: string;
}

export interface DocxSetTableCellsFormattingOperation {
  readonly table: DocxTableTarget;
  readonly updates: readonly {
    readonly target: DocxSemanticCellTarget;
    readonly fill?: string;
    readonly textFormatting?: {
      readonly bold?: boolean;
      readonly italic?: boolean;
      readonly fontFamily?: string;
      readonly fontSizeHalfPoints?: number;
      readonly color?: string;
    };
  }[];
  readonly baseRevision?: string;
}

/** Placement for insert_paragraph — engine protocol shape. */
export type DocxParagraphPlacement =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly handle: string }
  | { readonly kind: "after"; readonly handle: string };

export interface DocxInsertParagraphOperation {
  readonly text: string;
  readonly placement: DocxParagraphPlacement;
  readonly baseRevision?: string;
}

export interface DocxInsertParagraphsOperation {
  readonly texts: readonly string[];
  readonly placement: DocxParagraphPlacement;
  readonly baseRevision?: string;
}

/** Semantic text target used by delete / style / formatting N-API ops. */
export interface DocxTextTarget {
  readonly text: string;
  readonly occurrence?: number;
}

export interface DocxDeleteParagraphOperation {
  readonly target: DocxTextTarget;
  readonly baseRevision?: string;
}

export interface DocxSetParagraphStyleOperation {
  readonly target: DocxTextTarget;
  /** Omit or undefined → Clear style (N-API PropertyPatch::Clear). */
  readonly style?: string;
  readonly baseRevision?: string;
}

export type DocxParagraphAlignment = "left" | "center" | "right";

export interface DocxSetParagraphFormattingOperation {
  readonly target: DocxTextTarget;
  readonly alignment?: DocxParagraphAlignment | "clear";
  readonly spacingBeforeTwips?: number;
  readonly spacingAfterTwips?: number;
  readonly leftIndentTwips?: number;
  readonly clearLeftIndent?: boolean;
  readonly baseRevision?: string;
}

export interface DocxSetTextFormattingOperation {
  readonly target: DocxTextTarget;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
  readonly clearBold?: boolean;
  readonly color?: string;
  readonly clearColor?: boolean;
  readonly underline?: boolean;
  readonly clearUnderline?: boolean;
  readonly highlight?: string;
  readonly clearHighlight?: boolean;
  readonly strikethrough?: boolean;
  readonly clearStrikethrough?: boolean;
  readonly verticalAlignment?: "baseline" | "superscript" | "subscript";
  readonly clearVerticalAlignment?: boolean;
  readonly baseRevision?: string;
}

export interface DocxRuntimeCapabilities {
  readonly ok: boolean;
  readonly protocolVersion: number;
  readonly engineVersion: string;
  readonly formats: readonly {
    readonly format: string;
    readonly capabilities: readonly string[];
  }[];
}

export interface DocxFindTextRequest {
  readonly text: string;
}

export interface DocxFindTextMatch {
  readonly occurrence: number;
  readonly text: string;
  readonly before: string;
  readonly after: string;
  readonly container: string;
}

export interface DocxFindTextResult {
  readonly ok: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly matches: readonly DocxFindTextMatch[];
  readonly diagnostics: readonly DocxEngineDiagnostic[];
}

/** Focus shapes accepted by the DOCX N-API inspectDocx binding. */
export type DocxInspectFocus =
  | ({ readonly kind: "revisions" } & DocxRevisionOptions)
  | ({ readonly kind: "comments" } & DocxCommentOptions)
  | ({ readonly kind: "layout" } & DocxLayoutOptions)
  | { readonly kind: "sections" }
  | { readonly kind: "overview" }
  | {
      readonly kind: "headings";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "paragraphs";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "tables";
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly kind: "table_rows"; readonly tableHandle: string; readonly rowOffset?: number; readonly rowLimit?: number }
  | {
      readonly kind: "body_blocks";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "context";
      readonly text: string;
      readonly occurrence?: number;
      readonly before?: number;
      readonly after?: number;
    };

export interface DocxInspectRequest {
  readonly focus: DocxInspectFocus;
}

export interface DocxInspectionPageMeta {
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
}

export interface DocxInspectOverview {
  readonly bodyBlockCount: number;
  readonly paragraphCount: number;
  readonly tableCount: number;
  readonly sectionCount: number;
}

export interface DocxInspectHeadingItem {
  readonly occurrence: number;
  readonly text: string;
  readonly styleName: string;
  readonly level?: number;
}

export interface DocxInspectParagraphItem {
  /** Existing native list facts; absence means the paragraph is not a list item. */
  readonly list?: { readonly kind: string; readonly level: number; readonly supported: boolean };
  /** Position among direct body paragraphs; not a mutation selector. */
  readonly index?: number;
  /** Zero-based selector occurrence among matching mutable body paragraphs. */
  readonly targetOccurrence?: number;
  readonly handle?: string;
  /** @deprecated Older native bindings used a global paragraph index here. */
  readonly occurrence?: number;
  readonly text: string;
  readonly styleName?: string;
}

export interface DocxInspectTableColumn {
  readonly occurrence: number;
  readonly handle: string;
  readonly text: string;
}

/** Engine-authored affordance on an inspected DOCX object (transport only). */
export interface DocxInspectAffordance {
  readonly capability: string;
  readonly supported: boolean;
  readonly reason?: string;
}

export interface DocxInspectTableRow {
  readonly handle: string;
  readonly cells: readonly string[];
  readonly cellHandles: readonly string[];
  /**
   * Parallel to `cells` / `cellHandles` when the engine provides target-level
   * affordances. Omit entirely when the binding does not supply them.
   */
  readonly cellAffordances?: readonly (readonly DocxInspectAffordance[])[];
}

export interface DocxInspectTableItem {
  readonly occurrence: number;
  readonly handle: string;
  readonly rowCount: number;
  readonly isRectangular: boolean;
  readonly affordances?: readonly DocxInspectAffordance[];
  readonly columns: readonly DocxInspectTableColumn[];
  readonly rows: readonly DocxInspectTableRow[];
}
export interface DocxInspectTableRowWindow { readonly tableHandle: string; readonly rowCount: number; readonly columnCount: number; readonly headerTexts: readonly string[]; readonly rowOffset: number; readonly rows: readonly { readonly index: number; readonly cells: readonly string[] }[]; }

/** Ordered direct body block from engine inspect focus body_blocks. */
export interface DocxInspectBodyBlockItem {
  readonly handle: string;
  readonly kind: string;
  readonly text?: string | null;
  readonly styleName?: string | null;
  readonly headingLevel?: number | null;
  readonly tableHandle?: string | null;
  readonly rowCount?: number | null;
  readonly columnCount?: number | null;
  readonly headerTexts?: readonly string[] | null;
  readonly picture?: {
    readonly handle: string;
    readonly format: string;
    readonly widthEmu: number;
    readonly heightEmu: number;
    readonly altText?: string;
    readonly affordances?: readonly DocxInspectAffordance[];
  };
}

export interface DocxInspectContextUnit {
  readonly relativePosition: number;
  readonly text: string;
  readonly container: string;
}

export interface DocxInspectResult {
  readonly revisions?: DocxRevisionInspection;
  readonly comments?: DocxCommentInspection;
  readonly layout?: DocxLayoutSnapshot;
  readonly sections?: readonly DocxSection[];
  readonly ok: boolean;
  readonly focus: string;
  readonly overview?: DocxInspectOverview;
  readonly headings?: {
    readonly page: DocxInspectionPageMeta;
    readonly items: readonly DocxInspectHeadingItem[];
  };
  readonly paragraphs?: {
    readonly page: DocxInspectionPageMeta;
    readonly items: readonly DocxInspectParagraphItem[];
  };
  readonly tables?: {
    readonly page: DocxInspectionPageMeta;
    readonly items: readonly DocxInspectTableItem[];
  };
  readonly tableRows?: DocxInspectTableRowWindow;
  readonly bodyBlocks?: {
    readonly page: DocxInspectionPageMeta;
    readonly items: readonly DocxInspectBodyBlockItem[];
  };
  readonly context?: {
    readonly target: DocxReplaceTextTarget;
    readonly container?: DocxInspectContextUnit;
    readonly nearby: readonly DocxInspectContextUnit[];
  };
  readonly diagnostics: readonly DocxEngineDiagnostic[];
}

export interface DocxEngineBinding {
  inspectDocxTrackedChanges?(input: Uint8Array, options?: DocxRevisionOptions): Promise<DocxRevisionInspection>;
  inspectDocxComments?(input: Uint8Array, options?: DocxCommentOptions): Promise<DocxCommentInspection>;
  executeDocxAddComment?(input: Uint8Array, operation: DocxAddCommentOperation): Promise<DocxMutationBindingResult>;
  executeDocxUpdateComment?(input: Uint8Array, operation: DocxUpdateCommentOperation): Promise<DocxMutationBindingResult>;
  executeDocxDeleteComment?(input: Uint8Array, operation: DocxDeleteCommentOperation): Promise<DocxMutationBindingResult>;
  executeDocxInsertSectionBreak?(input: Uint8Array, operation: DocxInsertSectionBreakOperation): Promise<DocxMutationBindingResult>;
  executeDocxSetSectionProperties?(input: Uint8Array, operation: DocxSetSectionPropertiesOperation): Promise<DocxMutationBindingResult>;
  executeDocxSetSectionHeaderFooter?(input: Uint8Array, operation: DocxSetSectionHeaderFooterOperation): Promise<DocxMutationBindingResult>;
  executeDocxSetOddEvenHeaders?(input: Uint8Array, operation: { readonly enabled: boolean }): Promise<DocxMutationBindingResult>;
  getDocxCapabilities(): DocxRuntimeCapabilities;
  /**
   * Deterministic blank DOCX bytes from Rust.
   * Not a DocumentRuntime mutation — no DocumentRef exists yet.
   */
  createBlankDocx(): Uint8Array;
  findDocxText(
    input: Uint8Array,
    request: DocxFindTextRequest,
  ): Promise<DocxFindTextResult>;
  inspectDocx(
    input: Uint8Array,
    request: DocxInspectRequest,
  ): Promise<DocxInspectResult>;
  executeDocxInsertPicture?(input: Uint8Array, operation: DocxInsertPictureOperation): Promise<DocxMutationBindingResult>;
  executeDocxSetPictureLayout?(input: Uint8Array, operation: DocxSetPictureLayoutOperation): Promise<DocxMutationBindingResult>;
  executeDocxSetPictureSize?(input: Uint8Array, operation: DocxSetPictureSizeOperation): Promise<DocxMutationBindingResult>;
  executeDocxReplacePicture?(input: Uint8Array, operation: DocxReplacePictureOperation): Promise<DocxMutationBindingResult>;
  inspectDocxLayout?(input: Uint8Array, options?: DocxLayoutOptions): Promise<DocxLayoutSnapshot>;
  inspectDocxStyleSnapshot(input: Uint8Array): Promise<DocxStyleSnapshot>;
  executeDocxReplaceText(
    input: Uint8Array,
    operation: DocxReplaceTextOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxInsertParagraph(
    input: Uint8Array,
    operation: DocxInsertParagraphOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxInsertParagraphs(
    input: Uint8Array,
    operation: DocxInsertParagraphsOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxDeleteParagraph(
    input: Uint8Array,
    operation: DocxDeleteParagraphOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetParagraphStyle(
    input: Uint8Array,
    operation: DocxSetParagraphStyleOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetParagraphFormatting(
    input: Uint8Array,
    operation: DocxSetParagraphFormattingOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTextFormatting(
    input: Uint8Array,
    operation: DocxSetTextFormattingOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTableCellsText(
    input: Uint8Array,
    operation: DocxSetTableCellsTextOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxInsertTableRows(
    input: Uint8Array,
    operation: DocxInsertTableRowsOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxInsertTableColumn(
    input: Uint8Array,
    operation: DocxInsertTableColumnOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxCreateTable(
    input: Uint8Array,
    operation: DocxCreateTableOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxDeleteTable(
    input: Uint8Array,
    operation: DocxDeleteTableOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxDeleteTableRow(
    input: Uint8Array,
    operation: DocxDeleteTableRowOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxDeleteTableColumn(
    input: Uint8Array,
    operation: DocxDeleteTableColumnOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTableFormatting(
    input: Uint8Array,
    operation: DocxSetTableFormattingOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTableColumnWidths?(
    input: Uint8Array,
    operation: DocxSetTableColumnWidthsOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTableCellShading?(
    input: Uint8Array,
    operation: DocxSetTableCellShadingOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxSetTableCellsFormatting?(
    input: Uint8Array,
    operation: DocxSetTableCellsFormattingOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxCreateStyle?(input: Uint8Array, operation: DocxCreateStyleOperation): Promise<DocxMutationBindingResult>;
  executeDocxUpdateStyle?(input: Uint8Array, operation: DocxStyleOperation): Promise<DocxMutationBindingResult>;
  executeDocxExtended?(
    input: Uint8Array,
    name: DocxExtendedOperationName,
    operation: Record<string, unknown>,
  ): Promise<DocxMutationBindingResult>;
}

type NativeEngineModule = {
  inspectDocxTrackedChanges?: (input: Buffer, options?: DocxRevisionOptions) => Promise<string>;
  inspectDocxComments?: (input: Buffer, options?: DocxCommentOptions) => Promise<string>;
  executeDocxAddComment?: (input: Buffer, operation: Record<string, unknown>) => Promise<DocxMutationBindingResult>;
  executeDocxUpdateComment?: (input: Buffer, operation: Record<string, unknown>) => Promise<DocxMutationBindingResult>;
  executeDocxDeleteComment?: (input: Buffer, operation: Record<string, unknown>) => Promise<DocxMutationBindingResult>;
  inspectDocxLayout?: (input: Buffer, options?: DocxLayoutOptions) => Promise<string>;
  executeDocxCreateStyle?: (input: Buffer, operation: Record<string, unknown>) => Promise<DocxMutationBindingResult>;
  executeDocxUpdateStyle?: (input: Buffer, operation: Record<string, unknown>) => Promise<DocxMutationBindingResult>;
  getDocxCapabilities: () => {
    ok: boolean;
    protocolVersion: number;
    engineVersion: string;
    formats: Array<{ format: string; capabilities: string[] }>;
  };
  createBlankDocx: () => Buffer;
  findDocxText: (
    input: Buffer,
    request: { text: string },
  ) => Promise<{
    ok: boolean;
    query: string;
    matchCount: number;
    matches: Array<{
      occurrence: number;
      text: string;
      before: string;
      after: string;
      container: string;
    }>;
    diagnostics: DocxEngineDiagnostic[];
  }>;
  inspectDocx: (
    input: Buffer,
    request: { focus: Record<string, unknown> },
  ) => Promise<DocxInspectResult>;
  inspectDocxSections?: (input: Buffer) => Promise<string>;
  inspectDocxStyleSnapshot: (input: Buffer) => Promise<string>;
  executeDocxReplaceText: (
    input: Buffer,
    operation: {
      target: { text: string; occurrence?: number };
      expectedCurrentText: string;
      replacement: string;
      baseRevision?: string;
    },
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxInsertParagraph: (
    input: Buffer,
    operation: {
      text: string;
      placement: { kind: string; handle?: string };
      baseRevision?: string;
    },
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxInsertParagraphs: (
    input: Buffer,
    operation: {
      texts: string[];
      placement: { kind: string; handle?: string };
      baseRevision?: string;
    },
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxDeleteParagraph: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetParagraphStyle: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetParagraphFormatting: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetTextFormatting: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetTableCellsText: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxInsertTableRows: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxInsertTableColumn: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxCreateTable: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxDeleteTable: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxDeleteTableRow: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxDeleteTableColumn: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetTableFormatting: (
    input: Buffer,
    operation: Record<string, unknown>,
  ) => Promise<{
    result: DocxEngineOperationResult;
    output?: Buffer;
  }>;
  executeDocxSetTableColumnWidths: (input: Buffer, operation: Record<string, unknown>) => Promise<{ result: DocxEngineOperationResult; output?: Buffer }>;
  executeDocxSetTableCellShading: (input: Buffer, operation: Record<string, unknown>) => Promise<{ result: DocxEngineOperationResult; output?: Buffer }>;
  executeDocxSetTableCellsFormatting?: (input: Buffer, operation: Record<string, unknown>) => Promise<{ result: DocxEngineOperationResult; output?: Buffer }>;
  [name: string]: unknown;
};

function toNativeInspectFocus(focus: DocxInspectFocus): Record<string, unknown> {
  switch (focus.kind) {
    case "revisions":
    case "comments":
    case "layout":
      return { ...focus };
    case "sections":
      return { kind: "sections" };
    case "overview":
      return { kind: "overview" };
    case "headings":
    case "paragraphs":
    case "tables":
    case "body_blocks":
      return {
        kind: focus.kind,
        ...(focus.offset !== undefined ? { offset: focus.offset } : {}),
        ...(focus.limit !== undefined ? { limit: focus.limit } : {}),
      };
    case "table_rows":
      return { kind: "table_rows", tableHandle: focus.tableHandle, ...(focus.rowOffset !== undefined ? { offset: focus.rowOffset } : {}), ...(focus.rowLimit !== undefined ? { limit: focus.rowLimit } : {}) };
    case "context":
      return {
        kind: "context",
        text: focus.text,
        ...(focus.occurrence !== undefined
          ? { occurrence: focus.occurrence }
          : {}),
        ...(focus.before !== undefined ? { before: focus.before } : {}),
        ...(focus.after !== undefined ? { after: focus.after } : {}),
      };
  }
}

/**
 * Loads `@opensuitehq/engine` (npm N-API) and adapts it to DocxEngineBinding.
 * Call only from engine-client — never from agent-core.
 */
export async function createNapiDocxEngineBinding(): Promise<DocxEngineBinding> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { moduleId, fromEnv } = resolveNativeEngineModuleId();

  // When OPENSUITE_ENGINE_PATH is set, never fall back to the published package.
  if (fromEnv && !existsSync(moduleId)) {
    throw new Error(
      `OPENSUITE_ENGINE_PATH not found: ${moduleId} (refusing fallback to @opensuitehq/engine)`,
    );
  }

  let native: NativeEngineModule;
  try {
    native = require(moduleId) as NativeEngineModule;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    if (fromEnv) {
      throw new Error(
        `Failed to load local engine at OPENSUITE_ENGINE_PATH=${moduleId} (refusing fallback to @opensuitehq/engine). Underlying error: ${message}`,
      );
    }
    throw new Error(
      `Failed to load @opensuitehq/engine Node binding. Ensure @opensuitehq/engine@0.1.3 is installed for this platform (darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc; glibc only — no musl/Alpine). Underlying error: ${message}`,
    );
  }

  if (typeof native.createBlankDocx !== "function") {
    throw new Error(
      "@opensuitehq/engine is missing createBlankDocx — pin/install @opensuitehq/engine@0.1.3",
    );
  }
  if (typeof native.executeDocxInsertParagraph !== "function") {
    throw new Error(
      "@opensuitehq/engine is missing executeDocxInsertParagraph — pin/install @opensuitehq/engine@0.1.3",
    );
  }
  for (const name of [
    "executeDocxInsertParagraphs",
    "executeDocxDeleteParagraph",
    "executeDocxSetParagraphStyle",
    "executeDocxSetParagraphFormatting",
    "executeDocxSetTextFormatting",
    "executeDocxCreateTable",
    "executeDocxDeleteTable",
    "executeDocxDeleteTableRow",
    "executeDocxDeleteTableColumn",
    "executeDocxSetTableFormatting",
    "executeDocxSetTableColumnWidths",
    "executeDocxSetTableCellShading",
    "executeDocxSetContentControlText",
    "executeDocxSetParagraphsList",
    "executeDocxSetHyperlink",
    "executeDocxInsertPicture",
    "executeDocxDeletePicture",
    "executeDocxSetPictureSize",
    "executeDocxReplacePicture",
    "executeDocxInsertPageBreak",
    "executeDocxDeletePageBreak",
    "executeDocxSetPageSetup",
    "executeDocxSetHeaderFooterText",
    "executeDocxSetPageNumber",
    "executeDocxInsertTableRow",
  ] as const) {
    if (typeof native[name] !== "function") {
      throw new Error(
        `@opensuitehq/engine is missing ${name} — pin/install @opensuitehq/engine@0.1.3`,
      );
    }
  }

  const nativeCapabilities = native.getDocxCapabilities();
  // Published 0.1.3 implements semantic table paths but does not advertise the
  // semantic_* capability ids yet — accept by capability id or engineVersion.
  const supportsSemanticCellTargets =
    nativeSupportsSemanticTableCellTargets(nativeCapabilities);
  const supportsSemanticRowDeletion =
    nativeSupportsSemanticTableRowDeletion(nativeCapabilities);
  const requireSemanticCellTargets = (updates: readonly { readonly target: DocxSemanticCellTarget }[]) => {
    if (!supportsSemanticCellTargets && updates.some((update) =>
      update?.target && ("row" in update.target || "column" in update.target))) {
      throw new Error("installed native engine does not support semantic table-cell targets");
    }
  };

  async function executeExtended(input: Uint8Array, name: DocxExtendedOperationName, operation: Record<string, unknown>): Promise<DocxMutationBindingResult> {
    const method = native[name];
    if (typeof method !== "function") {
      throw new Error(`@opensuitehq/engine is missing ${name}`);
    }
    const response = await (method as (
      bytes: Buffer,
      payload: Record<string, unknown>,
    ) => Promise<{ result: DocxEngineOperationResult; output?: Buffer }>)(
      Buffer.from(input),
      operation,
    );
    return mapMutationBindingResponse(response);
  }

  return {
    getDocxCapabilities() {
      return native.getDocxCapabilities();
    },

    createBlankDocx() {
      const buffer = native.createBlankDocx();
      return new Uint8Array(buffer);
    },

    async findDocxText(input, request) {
      return native.findDocxText(Buffer.from(input), { text: request.text });
    },

    executeDocxInsertPicture(input, operation) {
      return executeExtended(input, "executeDocxInsertPicture", { ...operation, imageBytes: Buffer.from(operation.imageBytes) });
    },
    executeDocxSetPictureLayout(input, operation) {
      return executeExtended(input, "executeDocxSetPictureLayout", { ...operation });
    },
    executeDocxSetPictureSize(input, operation) {
      return executeExtended(input, "executeDocxSetPictureSize", { ...operation });
    },
    executeDocxReplacePicture(input, operation) {
      return executeExtended(input, "executeDocxReplacePicture", { ...operation, replacementBytes: Buffer.from(operation.replacementBytes) });
    },
    async executeDocxAddComment(input, operation) {
      return executeExtended(input, "executeDocxAddComment", { ...operation, target: toNativeTextTarget(operation.target), date: operation.date ?? new Date().toISOString() });
    },
    async executeDocxUpdateComment(input, operation) { return executeExtended(input, "executeDocxUpdateComment", { ...operation }); },
    async executeDocxDeleteComment(input, operation) { return executeExtended(input, "executeDocxDeleteComment", { ...operation }); },
    async inspectDocxTrackedChanges(input, options) {
      if (!native.inspectDocxTrackedChanges) throw new Error("Local engine is missing inspectDocxTrackedChanges");
      return JSON.parse(await native.inspectDocxTrackedChanges(Buffer.from(input), options)) as DocxRevisionInspection;
    },
    async inspectDocxComments(input, options) {
      if (!native.inspectDocxComments) throw new Error("Local engine is missing inspectDocxComments");
      return JSON.parse(await native.inspectDocxComments(Buffer.from(input), options)) as DocxCommentInspection;
    },
    async inspectDocxLayout(input, options) {
      if (!native.inspectDocxLayout) throw new Error("Local engine is missing inspectDocxLayout");
      return JSON.parse(await native.inspectDocxLayout(Buffer.from(input), options)) as DocxLayoutSnapshot;
    },
    async inspectDocx(input, request) {
      if (request.focus.kind === "revisions") {
        if (!native.inspectDocxTrackedChanges) throw new Error("Local engine is missing inspectDocxTrackedChanges");
        const { kind, ...options } = request.focus;
        const revisions = JSON.parse(await native.inspectDocxTrackedChanges(Buffer.from(input), options)) as DocxRevisionInspection;
        return { ok: revisions.ok, focus: "revisions", revisions, diagnostics: revisions.diagnostics.map(d => ({ ...d, severity: revisions.ok ? "warning" : "error" })) };
      }
      if (request.focus.kind === "comments") {
        if (!native.inspectDocxComments) throw new Error("Local engine is missing inspectDocxComments");
        const { kind, ...options } = request.focus;
        const comments = JSON.parse(await native.inspectDocxComments(Buffer.from(input), options)) as DocxCommentInspection;
        return { ok: comments.ok, focus: "comments", comments, diagnostics: comments.diagnostics.map(d => ({ ...d, severity: comments.ok ? "warning" : "error" })) };
      }
      if (request.focus.kind === "layout") {
        if (!native.inspectDocxLayout) throw new Error("Local engine is missing inspectDocxLayout");
        const { kind, ...options } = request.focus;
        const layout = JSON.parse(await native.inspectDocxLayout(Buffer.from(input), options)) as DocxLayoutSnapshot;
        return { ok: layout.ok, focus: "layout", layout, diagnostics: layout.diagnostics.map(d => ({ ...d, severity: !layout.ok ? "error" : d.code === "RENDERED_LAYOUT_UNAVAILABLE" ? "info" : "warning" })) };
      }
      if (request.focus.kind === "sections") {
        if (!native.inspectDocxSections) throw new Error("Local engine is missing inspectDocxSections");
        const result = JSON.parse(await native.inspectDocxSections(Buffer.from(input))) as DocxSectionInspection;
        return { ...result, focus: "sections" };
      }
      return native.inspectDocx(Buffer.from(input), {
        focus: toNativeInspectFocus(request.focus),
      });
    },

    async inspectDocxStyleSnapshot(input) {
      if (typeof native.inspectDocxStyleSnapshot !== "function") {
        throw new Error(
          "installed native engine is missing inspectDocxStyleSnapshot; use OPENSUITE_ENGINE_PATH for the local Phase 1 build",
        );
      }
      return JSON.parse(
        await native.inspectDocxStyleSnapshot(Buffer.from(input)),
      ) as DocxStyleSnapshot;
    },

    async executeDocxReplaceText(input, operation) {
      const response = await native.executeDocxReplaceText(Buffer.from(input), {
        target: {
          text: operation.target.text,
          ...(operation.target.occurrence !== undefined
            ? { occurrence: operation.target.occurrence }
            : {}),
        },
        expectedCurrentText: operation.expectedCurrentText,
        replacement: operation.replacement,
        ...(operation.baseRevision !== undefined
          ? { baseRevision: operation.baseRevision }
          : {}),
      });

      return mapMutationBindingResponse(response);
    },

    async executeDocxInsertParagraph(input, operation) {
      const response = await native.executeDocxInsertParagraph(
        Buffer.from(input),
        {
          text: operation.text,
          placement: toNativeParagraphPlacement(operation.placement),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxInsertParagraphs(input, operation) {
      const response = await native.executeDocxInsertParagraphs(
        Buffer.from(input),
        {
          texts: [...operation.texts],
          placement: toNativeParagraphPlacement(operation.placement),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxDeleteParagraph(input, operation) {
      const response = await native.executeDocxDeleteParagraph(
        Buffer.from(input),
        {
          target: toNativeTextTarget(operation.target),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetParagraphStyle(input, operation) {
      const response = await native.executeDocxSetParagraphStyle(
        Buffer.from(input),
        {
          target: toNativeTextTarget(operation.target),
          ...(operation.style !== undefined ? { style: operation.style } : {}),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetParagraphFormatting(input, operation) {
      const response = await native.executeDocxSetParagraphFormatting(
        Buffer.from(input),
        {
          target: toNativeTextTarget(operation.target),
          ...(operation.alignment !== undefined
            ? { alignment: operation.alignment }
            : {}),
          ...(operation.spacingBeforeTwips !== undefined
            ? { spacingBeforeTwips: operation.spacingBeforeTwips }
            : {}),
          ...(operation.spacingAfterTwips !== undefined
            ? { spacingAfterTwips: operation.spacingAfterTwips }
            : {}),
          ...(operation.leftIndentTwips !== undefined ? { leftIndentTwips: operation.leftIndentTwips } : {}),
          ...(operation.clearLeftIndent !== undefined ? { clearLeftIndent: operation.clearLeftIndent } : {}),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTextFormatting(input, operation) {
      const response = await native.executeDocxSetTextFormatting(
        Buffer.from(input),
        {
          target: toNativeTextTarget(operation.target),
          ...(operation.bold !== undefined ? { bold: operation.bold } : {}),
          ...(operation.italic !== undefined
            ? { italic: operation.italic }
            : {}),
          ...(operation.fontSizeHalfPoints !== undefined
            ? { fontSizeHalfPoints: operation.fontSizeHalfPoints }
            : {}),
          ...(operation.fontFamily !== undefined
            ? { fontFamily: operation.fontFamily }
            : {}),
          ...(operation.clearBold !== undefined ? { clearBold: operation.clearBold } : {}),
          ...(operation.color !== undefined ? { color: operation.color } : {}),
          ...(operation.clearColor !== undefined ? { clearColor: operation.clearColor } : {}),
          ...(operation.underline !== undefined ? { underline: operation.underline } : {}),
          ...(operation.clearUnderline !== undefined ? { clearUnderline: operation.clearUnderline } : {}),
          ...(operation.highlight !== undefined ? { highlight: operation.highlight } : {}),
          ...(operation.clearHighlight !== undefined ? { clearHighlight: operation.clearHighlight } : {}),
          ...(operation.strikethrough !== undefined ? { strikethrough: operation.strikethrough } : {}),
          ...(operation.clearStrikethrough !== undefined ? { clearStrikethrough: operation.clearStrikethrough } : {}),
          ...(operation.verticalAlignment !== undefined ? { verticalAlignment: operation.verticalAlignment } : {}),
          ...(operation.clearVerticalAlignment !== undefined ? { clearVerticalAlignment: operation.clearVerticalAlignment } : {}),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableCellsText(input, operation) {
      if (!Array.isArray(operation.updates)) {
        throw new MutationArgError("updates must be a non-empty array");
      }
      if (operation.updates.length === 0) {
        throw new MutationArgError("updates must be a non-empty array");
      }
      requireSemanticCellTargets(operation.updates);
      const updates = operation.updates.map((update, index) => {
        if (!update || typeof update !== "object") {
          throw new MutationArgError(`updates[${index}] must be an object`);
        }
        if (typeof update.expectedCurrentText !== "string") {
          throw new MutationArgError(
            `updates[${index}].expectedCurrentText is required`,
          );
        }
        if (typeof update.replacement !== "string") {
          throw new MutationArgError(
            `updates[${index}].replacement is required`,
          );
        }
        return {
          target: toNativeSemanticCellTarget(update.target),
          expectedCurrentText: update.expectedCurrentText,
          replacement: update.replacement,
        };
      });
      const response = await native.executeDocxSetTableCellsText(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          updates,
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxInsertTableRows(input, operation) {
      const response = await native.executeDocxInsertTableRows(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          after: toNativeRowAnchor(operation.after),
          rows: operation.rows.map((row) => [...row]),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxInsertTableColumn(input, operation) {
      const response = await native.executeDocxInsertTableColumn(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          ...(operation.afterColumnHeader !== undefined
            ? { afterColumnHeader: operation.afterColumnHeader }
            : {}),
          ...(operation.afterColumnHandle !== undefined
            ? { afterColumnHandle: operation.afterColumnHandle }
            : {}),
          header: operation.header,
          cells: [...operation.cells],
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxCreateTable(input, operation) {
      const response = await native.executeDocxCreateTable(Buffer.from(input), {
        rows: operation.rows.map((row) => [...row]),
        placement: toNativeParagraphPlacement(operation.placement),
        ...(operation.baseRevision !== undefined
          ? { baseRevision: operation.baseRevision }
          : {}),
      });
      return mapMutationBindingResponse(response);
    },

    async executeDocxDeleteTable(input, operation) {
      const response = await native.executeDocxDeleteTable(Buffer.from(input), {
        table: toNativeTableTarget(operation.table),
        ...(operation.baseRevision !== undefined
          ? { baseRevision: operation.baseRevision }
          : {}),
      });
      return mapMutationBindingResponse(response);
    },

    async executeDocxDeleteTableRow(input, operation) {
      if (operation.row && typeof operation.row === "object" && "kind" in operation.row && !supportsSemanticRowDeletion) {
        throw new Error("installed native engine does not support semantic table-row deletion");
      }
      const response = await native.executeDocxDeleteTableRow(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          row: toNativeDeleteRowTarget(operation.row),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxDeleteTableColumn(input, operation) {
      const response = await native.executeDocxDeleteTableColumn(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          ...(operation.columnHeader !== undefined
            ? { columnHeader: operation.columnHeader }
            : {}),
          ...(operation.columnHandle !== undefined
            ? { columnHandle: operation.columnHandle }
            : {}),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableFormatting(input, operation) {
      const response = await native.executeDocxSetTableFormatting(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          ...(operation.alignment !== undefined
            ? { alignment: operation.alignment }
            : {}),
          ...(operation.cellMarginTopTwips !== undefined
            ? { cellMarginTopTwips: operation.cellMarginTopTwips }
            : {}),
          ...(operation.cellMarginRightTwips !== undefined
            ? { cellMarginRightTwips: operation.cellMarginRightTwips }
            : {}),
          ...(operation.cellMarginBottomTwips !== undefined
            ? { cellMarginBottomTwips: operation.cellMarginBottomTwips }
            : {}),
          ...(operation.cellMarginLeftTwips !== undefined
            ? { cellMarginLeftTwips: operation.cellMarginLeftTwips }
            : {}),
          ...(operation.borders !== undefined
            ? { borders: operation.borders }
            : {}),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableColumnWidths(input, operation) {
      const response = await native.executeDocxSetTableColumnWidths(Buffer.from(input), {
        table: toNativeTableTarget(operation.table),
        widthsTwips: [...operation.widthsTwips],
        ...(operation.baseRevision !== undefined ? { baseRevision: operation.baseRevision } : {}),
      });
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableCellShading(input, operation) {
      if (!Array.isArray(operation.updates) || operation.updates.length === 0) {
        throw new MutationArgError("updates must be a non-empty array");
      }
      requireSemanticCellTargets(operation.updates);
      const response = await native.executeDocxSetTableCellShading(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          updates: operation.updates.map((update, index) => {
            if (!update || typeof update !== "object") {
              throw new MutationArgError(`updates[${index}] must be an object`);
            }
            return {
              target: toNativeSemanticCellTarget(update.target),
              ...(update.fill !== undefined ? { fill: update.fill } : {}),
            };
          }),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableCellsFormatting(input, operation) {
      if (!Array.isArray(operation.updates) || operation.updates.length === 0) {
        throw new MutationArgError("updates must be a non-empty array");
      }
      requireSemanticCellTargets(operation.updates);
      if (!native.executeDocxSetTableCellsFormatting) {
        throw new Error("@opensuitehq/engine is missing executeDocxSetTableCellsFormatting");
      }
      const response = await native.executeDocxSetTableCellsFormatting(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          updates: operation.updates.map((update, index) => {
            if (!update || typeof update !== "object") {
              throw new MutationArgError(`updates[${index}] must be an object`);
            }
            return {
              target: toNativeSemanticCellTarget(update.target),
              ...(update.fill !== undefined ? { fill: update.fill } : {}),
              ...(update.textFormatting !== undefined
                ? { textFormatting: update.textFormatting }
                : {}),
            };
          }),
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxInsertSectionBreak(input, operation) {
      return executeExtended(input, "executeDocxInsertSectionBreak", { ...operation });
    },
    async executeDocxSetSectionProperties(input, operation) {
      return executeExtended(input, "executeDocxSetSectionProperties", { ...operation });
    },
    async executeDocxSetSectionHeaderFooter(input, operation) {
      return executeExtended(input, "executeDocxSetSectionHeaderFooter", { ...operation });
    },
    async executeDocxSetOddEvenHeaders(input, operation) {
      return executeExtended(input, "executeDocxSetOddEvenHeaders", { ...operation });
    },

    async executeDocxCreateStyle(input, operation) { return executeExtended(input, "executeDocxCreateStyle", { ...operation }); },
    async executeDocxUpdateStyle(input, operation) { return executeExtended(input, "executeDocxUpdateStyle", { ...operation }); },
    executeDocxExtended: executeExtended,
  };
}

/**
 * Authoritative app-side check for semantic table-cell selectors.
 * Prefer capability ids when present; also accept engineVersion >= 0.1.3
 * because published 0.1.3 implements the paths without advertising the ids.
 */
export function nativeSupportsSemanticTableCellTargets(
  capabilities: Pick<DocxRuntimeCapabilities, "engineVersion" | "formats">,
): boolean {
  return (
    hasDocxCapability(capabilities, "semantic_table_cell_targets") ||
    engineVersionAtLeast(capabilities.engineVersion, "0.1.3")
  );
}

/** Same policy as cell targets for semantic row deletion selectors. */
export function nativeSupportsSemanticTableRowDeletion(
  capabilities: Pick<DocxRuntimeCapabilities, "engineVersion" | "formats">,
): boolean {
  return (
    hasDocxCapability(capabilities, "semantic_table_row_deletion") ||
    engineVersionAtLeast(capabilities.engineVersion, "0.1.3")
  );
}

/** Compact fingerprint of table/semantic capability ids for run traces. */
export function docxCapabilityFingerprint(
  capabilities: Pick<DocxRuntimeCapabilities, "formats">,
): readonly string[] {
  const caps =
    capabilities.formats.find((format) => format.format === "docx")?.capabilities ??
    [];
  return caps.filter(
    (id) => id.includes("table") || id.includes("semantic") || id === "inspect",
  );
}

function hasDocxCapability(
  capabilities: { readonly formats: readonly { readonly format: string; readonly capabilities: readonly string[] }[] },
  capability: string,
): boolean {
  return capabilities.formats.some(
    (format) => format.format === "docx" && format.capabilities.includes(capability),
  );
}

/** Simple dotted numeric compare for engine pins (e.g. 0.1.3 >= 0.1.3). */
export function engineVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(version);
  const right = parse(minimum);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function toNativeParagraphPlacement(
  placement: DocxParagraphPlacement,
): { kind: string; handle?: string } {
  return {
    kind: placement.kind,
    ...("handle" in placement ? { handle: placement.handle } : {}),
  };
}

/**
 * Pass occurrence through unchanged. Engine TextTarget / find / inspect
 * (targetOccurrence, match.occurrence) are all zero-based.
 */
function toNativeTextTarget(target: DocxTextTarget): Record<string, unknown> {
  if (!target || typeof target.text !== "string") {
    throw new MutationArgError("target.text is required");
  }
  if (
    target.occurrence !== undefined &&
    (!Number.isInteger(target.occurrence) || target.occurrence < 0)
  ) {
    throw new MutationArgError(
      "target.occurrence must be a non-negative integer (zero-based)",
    );
  }
  return {
    text: target.text,
    ...(target.occurrence !== undefined
      ? { occurrence: target.occurrence }
      : {}),
  };
}

/** Thrown for structurally invalid model args — mapped to VALIDATION_FAILED. */
export class MutationArgError extends Error {
  readonly reasonCode = "VALIDATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "MutationArgError";
  }
}

function toNativeTableTarget(table: DocxTableTarget): Record<string, unknown> {
  if (!table || typeof table !== "object") {
    throw new MutationArgError(
      "table must be an object with handle and/or headerCells",
    );
  }
  return {
    ...(table.headerCells !== undefined
      ? { headerCells: [...table.headerCells] }
      : {}),
    ...(table.occurrence !== undefined ? { occurrence: table.occurrence } : {}),
    ...(table.handle !== undefined ? { handle: table.handle } : {}),
  };
}

function toNativeRowAnchor(after: DocxTableRowAnchor): Record<string, unknown> {
  return {
    ...(after.firstCellText !== undefined
      ? { firstCellText: after.firstCellText }
      : {}),
    ...(after.occurrence !== undefined ? { occurrence: after.occurrence } : {}),
    ...(after.handle !== undefined ? { handle: after.handle } : {}),
  };
}

function toNativeDeleteRowTarget(row: DocxTableCellRow | DocxTableRowAnchor): Record<string, unknown> {
  if (!row || typeof row !== "object") {
    throw new MutationArgError("row must be a semantic selector, firstCellText, or handle");
  }
  if ("kind" in row) {
    if ("handle" in row || "firstCellText" in row) {
      throw new MutationArgError("use either a semantic row selector or a legacy row target");
    }
    validateSemanticRow(row);
    return row;
  }
  if (typeof row.handle !== "string" && typeof row.firstCellText !== "string") {
    throw new MutationArgError("row needs kind, firstCellText, or handle");
  }
  return toNativeRowAnchor(row);
}

function toNativeSemanticCellTarget(target: DocxSemanticCellTarget): Record<string, unknown> {
  if (target && typeof target === "object" && ("row" in target || "column" in target)) {
    if (!("row" in target) || !("column" in target)) {
      throw new MutationArgError("cell target needs both row and column");
    }
    if ("handle" in target || "rowLabel" in target || "columnHeader" in target || "occurrence" in target) {
      throw new MutationArgError("use either row + column or a legacy cell target");
    }
    const row = target.row;
    const column = target.column;
    if (!row || !column || typeof row !== "object" || typeof column !== "object") {
      throw new MutationArgError("cell target needs row and column objects");
    }
    validateSemanticRow(row);
    if (column.kind === "header" && typeof column.text !== "string" ||
        column.kind === "index" && (typeof column.expectedHeaderText !== "string" || !validIndex(column.index)) ||
        !["first", "header", "index"].includes(column.kind)) {
      throw new MutationArgError("invalid cell column selector");
    }
    if (column.kind === "header" && column.occurrence !== undefined && !validIndex(column.occurrence)) {
      throw new MutationArgError("cell occurrence must be a non-negative integer");
    }
    return { row, column };
  }
  return toNativeCellTarget(target as DocxTableCellTarget);
}

function validateSemanticRow(row: DocxTableCellRow): void {
  if (row.kind === "label" && (typeof row.text !== "string" ||
      row.occurrence !== undefined && !validIndex(row.occurrence)) ||
      row.kind === "index" && (typeof row.expectedFirstCellText !== "string" || !validIndex(row.index)) ||
      !["header", "label", "index"].includes(row.kind)) {
    throw new MutationArgError("invalid cell row selector");
  }
}

function validIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF;
}

function toNativeCellTarget(target: DocxTableCellTarget): Record<string, unknown> {
  if (!target || typeof target !== "object") {
    throw new MutationArgError(
      "updates[].target must be { handle } or { rowLabel, columnHeader, occurrence? }",
    );
  }
  if ("handle" in target && typeof target.handle === "string") {
    return { handle: target.handle };
  }
  if (
    "rowLabel" in target &&
    typeof target.rowLabel === "string" &&
    "columnHeader" in target &&
    typeof target.columnHeader === "string"
  ) {
    return {
      rowLabel: target.rowLabel,
      columnHeader: target.columnHeader,
      ...(target.occurrence !== undefined
        ? { occurrence: target.occurrence }
        : {}),
    };
  }
  throw new MutationArgError(
    "updates[].target must be { handle } or { rowLabel, columnHeader, occurrence? }",
  );
}

function mapMutationBindingResponse(response: {
  readonly result: DocxEngineOperationResult;
  readonly output?: Buffer | null;
}): DocxMutationBindingResult {
  return {
    result: response.result,
    ...(response.output !== undefined && response.output !== null
      ? { output: Uint8Array.from(response.output) }
      : {}),
  };
}
