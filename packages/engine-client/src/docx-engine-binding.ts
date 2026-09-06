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

export interface DocxEngineBinding {
  executeDocxReplaceText(
    input: Uint8Array,
    operation: DocxReplaceTextOperation,
  ): Promise<DocxReplaceTextBindingResult>;
}

/**
 * Loads the local `@opensuite/engine` N-API package and adapts it to
 * DocxEngineBinding. Call only from engine-client — never from agent-core.
 */
export async function createNapiDocxEngineBinding(): Promise<DocxEngineBinding> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  let native: {
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

  try {
    native = require("@opensuite/engine") as typeof native;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load @opensuite/engine Node binding. Build opensuite-engine/crates/opensuite-node (npm run build) and link it into this repo. Underlying error: ${message}`,
    );
  }

  return {
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
