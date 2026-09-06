import type {
  DocxEngineBinding,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInspectRequest,
  DocxInspectResult,
  DocxReplaceTextBindingResult,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
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
      ],
    },
  ],
};

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
    ) =>
      | DocxReplaceTextBindingResult
      | Promise<DocxReplaceTextBindingResult>;
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

  return {
    replaceCalls,
    findCalls,
    inspectCalls,
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
      return {
        ok: true,
        target: request.target,
        nearby: [],
        diagnostics: [],
      };
    },
    async executeDocxReplaceText(input, operation) {
      replaceCalls.push({ input, operation });
      if (overrides.executeDocxReplaceText) {
        return overrides.executeDocxReplaceText(input, operation);
      }
      return {
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              message: "execute not stubbed",
            },
          ],
          changes: [],
        },
      };
    },
  };
}
