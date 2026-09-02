import type { Diagnostic } from "./diagnostics.js";

/**
 * A non-empty array of diagnostics. Used to require, at the type level,
 * that a failed operation always explains itself with at least one
 * diagnostic.
 */
export type NonEmptyDiagnostics = readonly [Diagnostic, ...Diagnostic[]];

/**
 * Common result envelope for engine operations. Modeled as an explicit
 * discriminated union (tagged on `status`) rather than a thrown exception
 * or a bare boolean, so it serializes identically regardless of caller
 * language and stays extensible (e.g. a future "partial" status).
 */
export type EngineOperationResult<TData> =
  | {
      readonly status: "success";
      readonly data: TData;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "error";
      readonly diagnostics: NonEmptyDiagnostics;
    };
