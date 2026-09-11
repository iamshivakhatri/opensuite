import type {
  DocxCreateTableOperation,
  DocxDeleteParagraphOperation,
  DocxDeleteTableColumnOperation,
  DocxDeleteTableOperation,
  DocxDeleteTableRowOperation,
  DocxEngineBinding,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInsertParagraphOperation,
  DocxInsertParagraphsOperation,
  DocxInsertTableColumnOperation,
  DocxInsertTableRowsOperation,
  DocxInspectRequest,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
  DocxSetParagraphFormattingOperation,
  DocxSetParagraphStyleOperation,
  DocxSetTableCellsTextOperation,
  DocxSetTableFormattingOperation,
  DocxSetTableCellShadingOperation,
  DocxSetTableColumnWidthsOperation,
  DocxSetTextFormattingOperation,
} from "../docx-engine-binding.js";

const DEFAULT_CAPS: DocxRuntimeCapabilities = {
  ok: true,
  protocolVersion: 1,
  engineVersion: "test",
  formats: [
    {
      format: "docx",
      capabilities: [
        "inspect",
        "find_text",
        "inspect_context",
        "body_blocks",
        "replace_text",
        "create_blank_docx",
        "insert_paragraph",
        "insert_paragraphs",
        "delete_paragraph",
        "set_paragraph_style",
        "set_paragraph_formatting",
        "set_text_formatting",
        "set_table_cells_text",
        "insert_table_rows",
        "insert_table_column",
        "create_table",
        "delete_table",
        "delete_table_row",
        "delete_table_column",
        "set_table_formatting",
        "set_table_column_widths",
        "set_table_cell_shading",
      ],
    },
  ],
};

function notStubbed(code = "UNSUPPORTED_OPERATION"): DocxMutationBindingResult {
  return {
    result: {
      ok: false,
      status: "failed",
      diagnostics: [
        {
          code,
          severity: "error",
          message: "mutation not stubbed",
        },
      ],
      changes: [],
    },
  };
}

/** Minimal DocxEngineBinding for unit tests — override only what you need. */
export function createFakeDocxEngineBinding(
  overrides: {
    getDocxCapabilities?: () => DocxRuntimeCapabilities;
    createBlankDocx?: () => Uint8Array;
    findDocxText?: (
      input: Uint8Array,
      request: DocxFindTextRequest,
    ) => DocxFindTextResult | Promise<DocxFindTextResult>;
    inspectDocx?: (
      input: Uint8Array,
      request: DocxInspectRequest,
    ) => DocxInspectResult | Promise<DocxInspectResult>;
    executeDocxReplaceText?: (
      input: Uint8Array,
      operation: DocxReplaceTextOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxInsertParagraph?: (
      input: Uint8Array,
      operation: DocxInsertParagraphOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxInsertParagraphs?: (
      input: Uint8Array,
      operation: DocxInsertParagraphsOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxDeleteParagraph?: (
      input: Uint8Array,
      operation: DocxDeleteParagraphOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetParagraphStyle?: (
      input: Uint8Array,
      operation: DocxSetParagraphStyleOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetParagraphFormatting?: (
      input: Uint8Array,
      operation: DocxSetParagraphFormattingOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetTextFormatting?: (
      input: Uint8Array,
      operation: DocxSetTextFormattingOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetTableCellsText?: (
      input: Uint8Array,
      operation: DocxSetTableCellsTextOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxInsertTableRows?: (
      input: Uint8Array,
      operation: DocxInsertTableRowsOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxInsertTableColumn?: (
      input: Uint8Array,
      operation: DocxInsertTableColumnOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxCreateTable?: (
      input: Uint8Array,
      operation: DocxCreateTableOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxDeleteTable?: (
      input: Uint8Array,
      operation: DocxDeleteTableOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxDeleteTableRow?: (
      input: Uint8Array,
      operation: DocxDeleteTableRowOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxDeleteTableColumn?: (
      input: Uint8Array,
      operation: DocxDeleteTableColumnOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetTableFormatting?: (
      input: Uint8Array,
      operation: DocxSetTableFormattingOperation,
    ) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetTableColumnWidths?: (input: Uint8Array, operation: DocxSetTableColumnWidthsOperation) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
    executeDocxSetTableCellShading?: (input: Uint8Array, operation: DocxSetTableCellShadingOperation) => DocxMutationBindingResult | Promise<DocxMutationBindingResult>;
  } = {},
): DocxEngineBinding & {
  readonly replaceCalls: Array<{
    input: Uint8Array;
    operation: DocxReplaceTextOperation;
  }>;
  readonly findCalls: Array<{
    input: Uint8Array;
    request: DocxFindTextRequest;
  }>;
  readonly inspectCalls: Array<{
    input: Uint8Array;
    request: DocxInspectRequest;
  }>;
  readonly insertParagraphCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertParagraphOperation;
  }>;
  readonly insertParagraphsCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertParagraphsOperation;
  }>;
  readonly deleteParagraphCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteParagraphOperation;
  }>;
  readonly setParagraphStyleCalls: Array<{
    input: Uint8Array;
    operation: DocxSetParagraphStyleOperation;
  }>;
  readonly setParagraphFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetParagraphFormattingOperation;
  }>;
  readonly setTextFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTextFormattingOperation;
  }>;
  readonly setCellsCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTableCellsTextOperation;
  }>;
  readonly insertRowsCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertTableRowsOperation;
  }>;
  readonly insertColumnCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertTableColumnOperation;
  }>;
  readonly createTableCalls: Array<{
    input: Uint8Array;
    operation: DocxCreateTableOperation;
  }>;
  readonly deleteTableCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableOperation;
  }>;
  readonly deleteTableRowCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableRowOperation;
  }>;
  readonly deleteTableColumnCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableColumnOperation;
  }>;
  readonly setTableFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTableFormattingOperation;
  }>;
} {
  const replaceCalls: Array<{
    input: Uint8Array;
    operation: DocxReplaceTextOperation;
  }> = [];
  const findCalls: Array<{
    input: Uint8Array;
    request: DocxFindTextRequest;
  }> = [];
  const inspectCalls: Array<{
    input: Uint8Array;
    request: DocxInspectRequest;
  }> = [];
  const insertParagraphCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertParagraphOperation;
  }> = [];
  const insertParagraphsCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertParagraphsOperation;
  }> = [];
  const deleteParagraphCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteParagraphOperation;
  }> = [];
  const setParagraphStyleCalls: Array<{
    input: Uint8Array;
    operation: DocxSetParagraphStyleOperation;
  }> = [];
  const setParagraphFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetParagraphFormattingOperation;
  }> = [];
  const setTextFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTextFormattingOperation;
  }> = [];
  const setCellsCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTableCellsTextOperation;
  }> = [];
  const insertRowsCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertTableRowsOperation;
  }> = [];
  const insertColumnCalls: Array<{
    input: Uint8Array;
    operation: DocxInsertTableColumnOperation;
  }> = [];
  const createTableCalls: Array<{
    input: Uint8Array;
    operation: DocxCreateTableOperation;
  }> = [];
  const deleteTableCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableOperation;
  }> = [];
  const deleteTableRowCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableRowOperation;
  }> = [];
  const deleteTableColumnCalls: Array<{
    input: Uint8Array;
    operation: DocxDeleteTableColumnOperation;
  }> = [];
  const setTableFormattingCalls: Array<{
    input: Uint8Array;
    operation: DocxSetTableFormattingOperation;
  }> = [];

  return {
    replaceCalls,
    findCalls,
    inspectCalls,
    insertParagraphCalls,
    insertParagraphsCalls,
    deleteParagraphCalls,
    setParagraphStyleCalls,
    setParagraphFormattingCalls,
    setTextFormattingCalls,
    setCellsCalls,
    insertRowsCalls,
    insertColumnCalls,
    createTableCalls,
    deleteTableCalls,
    deleteTableRowCalls,
    deleteTableColumnCalls,
    setTableFormattingCalls,
    getDocxCapabilities:
      overrides.getDocxCapabilities ?? (() => DEFAULT_CAPS),
    createBlankDocx:
      overrides.createBlankDocx ??
      (() => {
        // Distinct sentinel bytes for tests that assert Rust bytes are stored.
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x62, 0x6c, 0x61, 0x6e, 0x6b]);
      }),
    async findDocxText(input, request) {
      findCalls.push({ input, request });
      if (overrides.findDocxText) {
        return overrides.findDocxText(input, request);
      }
      return {
        ok: true,
        query: request.text,
        matchCount: 0,
        matches: [],
        diagnostics: [],
      };
    },
    async inspectDocx(input, request) {
      inspectCalls.push({ input, request });
      if (overrides.inspectDocx) {
        return overrides.inspectDocx(input, request);
      }
      if (request.focus.kind === "context") {
        return {
          ok: true,
          focus: "context",
          context: {
            target: {
              text: request.focus.text,
              ...(request.focus.occurrence !== undefined
                ? { occurrence: request.focus.occurrence }
                : {}),
            },
            nearby: [],
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "overview") {
        return {
          ok: true,
          focus: "overview",
          overview: {
            bodyBlockCount: 0,
            paragraphCount: 0,
            tableCount: 0,
            sectionCount: 0,
          },
          diagnostics: [],
        };
      }
      if (request.focus.kind === "body_blocks") {
        return {
          ok: true,
          focus: "body_blocks",
          bodyBlocks: {
            page: { total: 0, offset: 0, returned: 0, hasMore: false },
            items: [],
          },
          diagnostics: [],
        };
      }
      return {
        ok: false,
        focus: request.focus.kind,
        diagnostics: [
          {
            code: "UNSUPPORTED_OPERATION",
            severity: "error",
            message: `stub does not implement ${request.focus.kind}`,
          },
        ],
      };
    },
    async executeDocxReplaceText(input, operation) {
      replaceCalls.push({ input, operation });
      if (overrides.executeDocxReplaceText) {
        return overrides.executeDocxReplaceText(input, operation);
      }
      return notStubbed();
    },
    async executeDocxInsertParagraph(input, operation) {
      insertParagraphCalls.push({ input, operation });
      if (overrides.executeDocxInsertParagraph) {
        return overrides.executeDocxInsertParagraph(input, operation);
      }
      return notStubbed();
    },
    async executeDocxInsertParagraphs(input, operation) {
      insertParagraphsCalls.push({ input, operation });
      if (overrides.executeDocxInsertParagraphs) {
        return overrides.executeDocxInsertParagraphs(input, operation);
      }
      return notStubbed();
    },
    async executeDocxDeleteParagraph(input, operation) {
      deleteParagraphCalls.push({ input, operation });
      if (overrides.executeDocxDeleteParagraph) {
        return overrides.executeDocxDeleteParagraph(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetParagraphStyle(input, operation) {
      setParagraphStyleCalls.push({ input, operation });
      if (overrides.executeDocxSetParagraphStyle) {
        return overrides.executeDocxSetParagraphStyle(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetParagraphFormatting(input, operation) {
      setParagraphFormattingCalls.push({ input, operation });
      if (overrides.executeDocxSetParagraphFormatting) {
        return overrides.executeDocxSetParagraphFormatting(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetTextFormatting(input, operation) {
      setTextFormattingCalls.push({ input, operation });
      if (overrides.executeDocxSetTextFormatting) {
        return overrides.executeDocxSetTextFormatting(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetTableCellsText(input, operation) {
      setCellsCalls.push({ input, operation });
      if (overrides.executeDocxSetTableCellsText) {
        return overrides.executeDocxSetTableCellsText(input, operation);
      }
      return notStubbed();
    },
    async executeDocxInsertTableRows(input, operation) {
      insertRowsCalls.push({ input, operation });
      if (overrides.executeDocxInsertTableRows) {
        return overrides.executeDocxInsertTableRows(input, operation);
      }
      return notStubbed();
    },
    async executeDocxInsertTableColumn(input, operation) {
      insertColumnCalls.push({ input, operation });
      if (overrides.executeDocxInsertTableColumn) {
        return overrides.executeDocxInsertTableColumn(input, operation);
      }
      return notStubbed();
    },
    async executeDocxCreateTable(input, operation) {
      createTableCalls.push({ input, operation });
      if (overrides.executeDocxCreateTable) {
        return overrides.executeDocxCreateTable(input, operation);
      }
      return notStubbed();
    },
    async executeDocxDeleteTable(input, operation) {
      deleteTableCalls.push({ input, operation });
      if (overrides.executeDocxDeleteTable) {
        return overrides.executeDocxDeleteTable(input, operation);
      }
      return notStubbed();
    },
    async executeDocxDeleteTableRow(input, operation) {
      deleteTableRowCalls.push({ input, operation });
      if (overrides.executeDocxDeleteTableRow) {
        return overrides.executeDocxDeleteTableRow(input, operation);
      }
      return notStubbed();
    },
    async executeDocxDeleteTableColumn(input, operation) {
      deleteTableColumnCalls.push({ input, operation });
      if (overrides.executeDocxDeleteTableColumn) {
        return overrides.executeDocxDeleteTableColumn(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetTableFormatting(input, operation) {
      setTableFormattingCalls.push({ input, operation });
      if (overrides.executeDocxSetTableFormatting) {
        return overrides.executeDocxSetTableFormatting(input, operation);
      }
      return notStubbed();
    },
    async executeDocxSetTableColumnWidths(input, operation) {
      return overrides.executeDocxSetTableColumnWidths?.(input, operation) ?? notStubbed();
    },
    async executeDocxSetTableCellShading(input, operation) {
      return overrides.executeDocxSetTableCellShading?.(input, operation) ?? notStubbed();
    },
  };
}
