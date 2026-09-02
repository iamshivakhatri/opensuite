/**
 * Severity of a structured diagnostic returned by the engine.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * A single machine-readable diagnostic emitted by the engine.
 *
 * `code` is a stable, namespaced identifier (e.g. "engine.docx.malformed_xml")
 * that callers branch on. `message` is for humans/logs only and must never
 * be parsed for control flow.
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  /**
   * Optional engine-defined location within the document that this
   * diagnostic relates to (e.g. a paragraph id, slide index, cell
   * reference). Format is engine-defined and opaque to this contract.
   */
  readonly path?: string;
}
