import type {
  CapabilityId,
  Diagnostic,
  DocumentFormat,
  DocumentRef,
  NonEmptyDiagnostics,
  RuntimeCapabilities,
  SemanticTarget,
} from "./types.js";
import { createCapabilities, hasCapability } from "./types.js";

/**
 * Minimal format-aware inspection summary.
 * Not a duplicate of the Rust DOCX semantic model — grow via payload later.
 */
export interface DocumentInspectionSummary {
  readonly title: string | null;
  readonly unitKind: "page" | "slide" | "sheet";
  readonly unitCount: number;
}

/**
 * Discriminated inspection payload. Format-specific fields can extend each arm
 * later without forcing one universal semantic tree.
 */
export type InspectionPayload =
  | {
      readonly format: "docx";
      readonly summary: DocumentInspectionSummary;
    }
  | {
      readonly format: "pptx";
      readonly summary: DocumentInspectionSummary;
    }
  | {
      readonly format: "xlsx";
      readonly summary: DocumentInspectionSummary;
    };

export type InspectionResult =
  | {
      readonly status: "success";
      readonly format: DocumentFormat;
      readonly capabilities: RuntimeCapabilities;
      readonly diagnostics: readonly Diagnostic[];
      readonly payload: InspectionPayload;
    }
  | {
      readonly status: "error";
      readonly diagnostics: NonEmptyDiagnostics;
    };

/**
 * Future mutation request. Intentionally generic — not a mutation language yet.
 * Must never carry engine NodeIds.
 */
export interface DocumentOperation {
  readonly type: string;
  readonly baseVersionId: string;
  readonly target?: SemanticTarget;
  readonly payload: Record<string, unknown>;
}

export type OperationFailureCode =
  | "UNSUPPORTED_CAPABILITY"
  | "TARGET_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | (string & {});

/**
 * Future mutation result. Partial-success philosophy lives at the agent/tool
 * layer; a single operation is still success|error here.
 */
export type OperationResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly Diagnostic[];
      readonly affected?: readonly SemanticTarget[];
      /** Candidate artifact id — persistence remains outside agent-core. */
      readonly outputVersionCandidateId?: string;
    }
  | {
      readonly status: "error";
      readonly code: OperationFailureCode;
      readonly diagnostics: NonEmptyDiagnostics;
    };

export interface DocumentRuntimeOptions {
  readonly signal?: AbortSignal;
}

/**
 * Capability-based document boundary for agent-core.
 * Implementations adapt engine-client / fakes; agent-core never sees XML/OPC/NodeId.
 *
 * `execute` is optional: call only when `document.mutate` (or equivalent) is advertised.
 */
export interface DocumentRuntime {
  capabilities(document: DocumentRef): RuntimeCapabilities | Promise<RuntimeCapabilities>;

  inspect(
    document: DocumentRef,
    options?: DocumentRuntimeOptions,
  ): Promise<InspectionResult>;

  execute?(
    document: DocumentRef,
    operation: DocumentOperation,
    options?: DocumentRuntimeOptions,
  ): Promise<OperationResult>;
}

/** Helper: unsupported capability error result for inspect/execute paths. */
export function unsupportedCapabilityResult(
  capability: CapabilityId,
): InspectionResult {
  return {
    status: "error",
    diagnostics: [
      {
        code: "UNSUPPORTED_CAPABILITY",
        severity: "error",
        message: `Runtime does not support capability: ${capability}`,
        details: { capability },
      },
    ],
  };
}

export function unsupportedCapabilityOperation(
  capability: CapabilityId,
): OperationResult {
  return {
    status: "error",
    code: "UNSUPPORTED_CAPABILITY",
    diagnostics: [
      {
        code: "UNSUPPORTED_CAPABILITY",
        severity: "error",
        message: `Runtime does not support capability: ${capability}`,
        details: { capability },
      },
    ],
  };
}

export function runtimeSupports(
  capabilities: RuntimeCapabilities,
  capability: CapabilityId,
): boolean {
  return hasCapability(capabilities, capability);
}

export { createCapabilities };
