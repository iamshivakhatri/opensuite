/**
 * Office document formats OpenSuite operates on. `opensuite-engine` owns
 * everything below this boundary (parsing, structure, mutation).
 */
export type DocumentFormat = "docx" | "pptx" | "xlsx";

/**
 * How the engine should obtain a document's bytes for an operation.
 *
 * - `inline`: the caller sends content directly (base64-encoded). Useful for
 *   small documents, tests, and early development.
 * - `reference`: the caller sends an opaque handle that is resolved to
 *   content out-of-band. Ownership of that handle (storage, versioning) is
 *   intentionally not defined by this contract.
 */
export type DocumentInput =
  | {
      readonly kind: "inline";
      readonly format: DocumentFormat;
      readonly contentBase64: string;
    }
  | {
      readonly kind: "reference";
      readonly format: DocumentFormat;
      readonly handle: string;
    };

/**
 * High-level, format-agnostic metadata about a document. Deliberately
 * shallow — detailed structural modeling is deferred until real engine
 * capabilities exist to inform it.
 */
export interface DocumentMetadata {
  readonly format: DocumentFormat;
  readonly title: string | null;
  readonly sizeBytes: number | null;
}

/**
 * Coarse top-level structural summary of a document. `unitKind` names what
 * is being counted so a single shape works across formats instead of a bag
 * of optional per-format fields.
 */
export interface DocumentStructureSummary {
  readonly unitKind: "page" | "slide" | "sheet";
  readonly unitCount: number;
}
