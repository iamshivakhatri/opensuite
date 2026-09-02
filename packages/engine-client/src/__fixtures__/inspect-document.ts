/**
 * Realistic fixture data for `inspect_document`, used by this package's own
 * tests. Not part of the public API (not exported from `index.ts`) — kept
 * here so tests read like real usage instead of ad hoc inline literals.
 */
import type {
  InspectDocumentRequest,
  InspectDocumentResult,
} from "@opensuite/contracts";

export const sampleInspectDocumentRequest: InspectDocumentRequest = {
  document: {
    kind: "inline",
    format: "docx",
    contentBase64: "UEsDBBQAAAAIAA==",
  },
  requestId: "req_sample_001",
};

export const sampleInspectDocumentSuccess: InspectDocumentResult = {
  status: "success",
  data: {
    metadata: { format: "docx", title: "Q3 Planning Notes", sizeBytes: 48213 },
    structure: { unitKind: "page", unitCount: 4 },
  },
  diagnostics: [],
};

export const sampleInspectDocumentFailure: InspectDocumentResult = {
  status: "error",
  diagnostics: [
    {
      severity: "error",
      code: "engine.docx.malformed_xml",
      message: "document.xml could not be parsed: unexpected end of file",
      path: "word/document.xml",
    },
  ],
};
