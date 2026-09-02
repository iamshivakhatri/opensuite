import type {
  DocumentInput,
  DocumentMetadata,
  DocumentStructureSummary,
} from "../document.js";
import type { EngineOperationResult } from "../result.js";

/**
 * Request for the first engine capability: inspecting a document without
 * mutating it.
 */
export interface InspectDocumentRequest {
  readonly document: DocumentInput;
  /** Optional caller-supplied id for tracing/audit correlation. */
  readonly requestId?: string;
}

/**
 * Successful inspection payload.
 */
export interface InspectDocumentData {
  readonly metadata: DocumentMetadata;
  readonly structure: DocumentStructureSummary;
}

export type InspectDocumentResult = EngineOperationResult<InspectDocumentData>;
