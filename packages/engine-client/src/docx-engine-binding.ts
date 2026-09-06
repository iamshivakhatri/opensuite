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

export interface DocxInspectRequest {
  readonly target: DocxReplaceTextTarget;
  readonly before?: number;
  readonly after?: number;
}

export interface DocxInspectContextUnit {
  readonly relativePosition: number;
  readonly text: string;
  readonly container: string;
}

export interface DocxInspectResult {
  readonly ok: boolean;
  readonly target: DocxReplaceTextTarget;
  readonly container?: DocxInspectContextUnit;
  readonly nearby: readonly DocxInspectContextUnit[];
  readonly diagnostics: readonly DocxEngineDiagnostic[];
}

export interface DocxEngineBinding {
  getDocxCapabilities(): DocxRuntimeCapabilities;
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
  ): Promise<DocxReplaceTextBindingResult>;
}

type NativeEngineModule = {
  getDocxCapabilities: () => {
    ok: boolean;
    protocolVersion: number;
    engineVersion: string;
    formats: Array<{ format: string; capabilities: string[] }>;
  };
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
    request: {
      target: { text: string; occurrence?: number };
      before?: number;
      after?: number;
    },
  ) => Promise<{
    ok: boolean;
    target: { text: string; occurrence?: number };
    container?: {
      relativePosition: number;
      text: string;
      container: string;
    };
    nearby: Array<{
      relativePosition: number;
      text: string;
      container: string;
    }>;
    diagnostics: DocxEngineDiagnostic[];
  }>;
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
};

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

  return {
    getDocxCapabilities() {
      return native.getDocxCapabilities();
    },

    async findDocxText(input, request) {
      return native.findDocxText(Buffer.from(input), { text: request.text });
    },

    async inspectDocx(input, request) {
      return native.inspectDocx(Buffer.from(input), {
        target: {
          text: request.target.text,
          ...(request.target.occurrence !== undefined
            ? { occurrence: request.target.occurrence }
            : {}),
        },
        ...(request.before !== undefined ? { before: request.before } : {}),
        ...(request.after !== undefined ? { after: request.after } : {}),
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

      return {
        result: response.result,
        ...(response.output !== undefined && response.output !== null
          ? { output: Uint8Array.from(response.output) }
          : {}),
      };
    },
  };
}
