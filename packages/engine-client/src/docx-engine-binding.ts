/**
 * Narrow Node-binding surface used by OpenSuiteEngineAdapter.
 *
 * Hides N-API / Buffer details from DocumentRuntime callers. A future HTTP
 * or remote transport can implement the same shape without changing agents.
 */

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

export interface DocxTableCellUpdate {
  readonly target: DocxTableCellTarget;
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
  readonly occurrence: number;
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

/** Ordered direct body block from engine inspect focus body_blocks. */
export interface DocxInspectBodyBlockItem {
  readonly handle: string;
  readonly kind: string;
  readonly text?: string | null;
  readonly tableHandle?: string | null;
}

export interface DocxInspectContextUnit {
  readonly relativePosition: number;
  readonly text: string;
  readonly container: string;
}

export interface DocxInspectResult {
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
  executeDocxReplaceText(
    input: Uint8Array,
    operation: DocxReplaceTextOperation,
  ): Promise<DocxMutationBindingResult>;
  executeDocxInsertParagraph(
    input: Uint8Array,
    operation: DocxInsertParagraphOperation,
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
}

type NativeEngineModule = {
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
};

function toNativeInspectFocus(focus: DocxInspectFocus): Record<string, unknown> {
  switch (focus.kind) {
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
 * Loads the local `@opensuite/engine` N-API package and adapts it to
 * DocxEngineBinding. Call only from engine-client — never from agent-core.
 */
export async function createNapiDocxEngineBinding(): Promise<DocxEngineBinding> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  let native: NativeEngineModule;
  try {
    native = require("@opensuite/engine") as NativeEngineModule;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load @opensuite/engine Node binding. Build opensuite-engine/crates/opensuite-node (npm run build) and link it into this repo. Underlying error: ${message}`,
    );
  }

  if (typeof native.createBlankDocx !== "function") {
    throw new Error(
      "@opensuite/engine is missing createBlankDocx — rebuild opensuite-engine/crates/opensuite-node for Milestone 5A APIs",
    );
  }
  if (typeof native.executeDocxInsertParagraph !== "function") {
    throw new Error(
      "@opensuite/engine is missing executeDocxInsertParagraph — rebuild opensuite-engine/crates/opensuite-node for Milestone 5A APIs",
    );
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

    async inspectDocx(input, request) {
      return native.inspectDocx(Buffer.from(input), {
        focus: toNativeInspectFocus(request.focus),
      });
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
          placement: {
            kind: operation.placement.kind,
            ...("handle" in operation.placement
              ? { handle: operation.placement.handle }
              : {}),
          },
          ...(operation.baseRevision !== undefined
            ? { baseRevision: operation.baseRevision }
            : {}),
        },
      );
      return mapMutationBindingResponse(response);
    },

    async executeDocxSetTableCellsText(input, operation) {
      const response = await native.executeDocxSetTableCellsText(
        Buffer.from(input),
        {
          table: toNativeTableTarget(operation.table),
          updates: operation.updates.map((update) => ({
            target: toNativeCellTarget(update.target),
            expectedCurrentText: update.expectedCurrentText,
            replacement: update.replacement,
          })),
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
  };
}

function toNativeTableTarget(table: DocxTableTarget): Record<string, unknown> {
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

function toNativeCellTarget(target: DocxTableCellTarget): Record<string, unknown> {
  if ("handle" in target) {
    return { handle: target.handle };
  }
  return {
    rowLabel: target.rowLabel,
    columnHeader: target.columnHeader,
    ...(target.occurrence !== undefined ? { occurrence: target.occurrence } : {}),
  };
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
