import type {
  DocxEngineBinding,
  DocxFindTextRequest,
  DocxFindTextResult,
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
        "replace_text",
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
    setCellsCalls,
    insertRowsCalls,
    insertColumnCalls,
    getDocxCapabilities:
      overrides.getDocxCapabilities ?? (() => DEFAULT_CAPS),
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
      return {
        ok: false,
        focus: request.focus.kind,
        diagnostics: [
          {
            code: "UNSUPPORTED_OPERATION",
            severity: "error",
            message: `inspect focus ${request.focus.kind} not stubbed`,
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
