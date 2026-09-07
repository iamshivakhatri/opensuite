import type {
  DocxEngineBinding,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInsertParagraphOperation,
  DocxInsertTableColumnOperation,
  DocxInsertTableRowsOperation,
  DocxInspectRequest,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
  DocxSetTableCellsTextOperation,
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
        "set_table_cells_text",
        "insert_table_rows",
        "insert_table_column",
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

  return {
    replaceCalls,
    findCalls,
    inspectCalls,
    insertParagraphCalls,
    setCellsCalls,
    insertRowsCalls,
    insertColumnCalls,
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
  };
}
