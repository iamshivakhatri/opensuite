/**
 * Compile-time checks for the engine contracts. These assert that the
 * discriminated unions narrow and stay exhaustive, and that the type-level
 * invariants (e.g. "error" results must carry at least one diagnostic)
 * actually hold. Not part of the package's public API and not exported
 * from `index.ts` — they exist purely so `tsc` fails the build if a future
 * change silently breaks these guarantees.
 */
import type { Diagnostic } from "../diagnostics.js";
import type { InspectDocumentResult } from "../operations/inspect-document.js";

function assertNever(value: never): never {
  throw new Error(`Unreachable engine result status: ${JSON.stringify(value)}`);
}

/**
 * Exhaustively handles every `InspectDocumentResult` status. Adding a new
 * status without updating this function is a compile error.
 */
function describeInspectResult(result: InspectDocumentResult): string {
  switch (result.status) {
    case "success":
      return `ok: ${result.data.structure.unitCount} ${result.data.structure.unitKind}(s)`;
    case "error":
      // `diagnostics[0]` is statically known to exist because `diagnostics`
      // on the error branch is typed as a non-empty tuple, not `Diagnostic[]`.
      return `failed: ${result.diagnostics[0].code}`;
    default:
      return assertNever(result);
  }
}

const sampleDiagnostic: Diagnostic = {
  severity: "error",
  code: "engine.docx.malformed_xml",
  message: "example diagnostic for compile-time checking",
};

const successSample: InspectDocumentResult = {
  status: "success",
  data: {
    metadata: { format: "docx", title: null, sizeBytes: null },
    structure: { unitKind: "page", unitCount: 1 },
  },
  diagnostics: [],
};

const errorSample: InspectDocumentResult = {
  status: "error",
  diagnostics: [sampleDiagnostic],
};

// The following, if uncommented, must fail to compile because "error"
// requires a non-empty diagnostics tuple:
//
// const invalidErrorSample: InspectDocumentResult = {
//   status: "error",
//   diagnostics: [],
// };

void describeInspectResult(successSample);
void describeInspectResult(errorSample);
