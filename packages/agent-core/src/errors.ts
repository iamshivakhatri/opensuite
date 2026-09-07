import type { Diagnostic } from "./types.js";

export type AgentCoreErrorCode =
  | "MODEL_FAILURE"
  | "TOOL_FAILURE"
  | "RUNTIME_FAILURE"
  | "CANCELLED"
  | "UNSUPPORTED_CAPABILITY"
  | "STALE_HANDLE"
  | "UNKNOWN_HANDLE"
  | "INVALID_TOOL_INPUT"
  | "DUPLICATE_TOOL_NAME"
  | "TOOL_NOT_FOUND"
  | "MAX_TURNS_EXCEEDED"
  | "CONFIRMATION_DENIED"
  | "UNKNOWN_TOOL";

/**
 * Typed agent-core failure. Prefer this (or structured diagnostics on results)
 * over opaque thrown Errors for control-flow conditions.
 */
export class AgentCoreError extends Error {
  readonly code: AgentCoreErrorCode;
  readonly diagnostic: Diagnostic | undefined;

  constructor(
    code: AgentCoreErrorCode,
    message: string,
    options?: { diagnostic?: Diagnostic; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentCoreError";
    this.code = code;
    this.diagnostic = options?.diagnostic;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    ("name" in error && error.name === "AbortError") ||
    ("code" in error && error.code === "CANCELLED")
  );
}
