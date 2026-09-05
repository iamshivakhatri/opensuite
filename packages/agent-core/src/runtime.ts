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

/** Opaque semantic handle + short label for agent-facing structure. */
export interface InspectedBlock {
  readonly handle: string;
  readonly text: string;
}

export interface InspectedHeading extends InspectedBlock {
  readonly level: number;
}

export interface InspectedTable {
  readonly handle: string;
  readonly rows: number;
  readonly cols: number;
  /** Small preview grid when available. */
  readonly preview?: readonly (readonly string[])[];
}

export interface InspectedSlide {
  readonly handle: string;
  readonly index: number;
  readonly title: string | null;
  readonly text: readonly string[];
}

export interface InspectedSheet {
  readonly handle: string;
  readonly name: string;
  readonly rowCount: number;
  readonly colCount: number;
}

export interface InspectedCell {
  readonly handle: string;
  readonly sheet: string;
  readonly address: string;
  readonly value: string | number | null;
}

/**
 * Discriminated inspection payload. Format-specific fields can extend each arm
 * later without forcing one universal semantic tree.
 *
 * Optional collections are populated based on inspect focus — not always a
 * full document dump.
 */
export type InspectionPayload =
  | {
      readonly format: "docx";
      readonly summary: DocumentInspectionSummary;
      readonly headings?: readonly InspectedHeading[];
      readonly paragraphs?: readonly InspectedBlock[];
      readonly tables?: readonly InspectedTable[];
    }
  | {
      readonly format: "pptx";
      readonly summary: DocumentInspectionSummary;
      readonly slides?: readonly InspectedSlide[];
    }
  | {
      readonly format: "xlsx";
      readonly summary: DocumentInspectionSummary;
      readonly sheets?: readonly InspectedSheet[];
      readonly cells?: readonly InspectedCell[];
    };

export type InspectionResult =
  | {
      readonly status: "success";
      readonly format: DocumentFormat;
      readonly capabilities: RuntimeCapabilities;
      readonly diagnostics: readonly Diagnostic[];
      readonly payload: InspectionPayload;
      /** Echo of the focus used for this inspection. */
      readonly focus: DocumentInspectFocus;
    }
  | {
      readonly status: "error";
      readonly diagnostics: NonEmptyDiagnostics;
    };

/**
 * Targeted inspect request. Prefer a narrow focus over dumping the whole file.
 */
export type DocumentInspectFocus =
  | { readonly kind: "overview" }
  | { readonly kind: "structure" }
  | { readonly kind: "headings" }
  | { readonly kind: "paragraphs" }
  | { readonly kind: "tables" }
  | { readonly kind: "slides" }
  | { readonly kind: "slide"; readonly index: number }
  | { readonly kind: "sheets" }
  | { readonly kind: "range"; readonly sheet?: string; readonly address?: string };

export interface DocumentFindQuery {
  readonly query: string;
  /** `text` = literal/substring; `semantic` = case-insensitive keyword match. */
  readonly mode?: "text" | "semantic";
  readonly maxResults?: number;
}

export interface FindMatch {
  /** Opaque handle — never an engine NodeId. */
  readonly handle: string;
  readonly excerpt: string;
  /** Human-readable location label (section, slide, sheet!A1, …). */
  readonly location: string;
  readonly score?: number;
}

export type FindResult =
  | {
      readonly status: "success";
      readonly query: string;
      readonly mode: "text" | "semantic";
      readonly matches: readonly FindMatch[];
      readonly diagnostics: readonly Diagnostic[];
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

/**
 * Application-owned change summary from a single mutation.
 * Not a durable diff/version system — just enough for grounded agent replies.
 */
export interface DocumentChangeSummary {
  readonly operation: string;
  /** Semantic area label (heading, slide 2, Revenue!B2, …). */
  readonly area: string;
  readonly before: string;
  readonly after: string;
}

export type OperationFailureCode =
  | "UNSUPPORTED_CAPABILITY"
  | "TARGET_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | (string & {});

/**
 * Mutation result. Partial-success philosophy lives at the agent/tool
 * layer; a single operation is still success|error here.
 */
export type OperationResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly Diagnostic[];
      readonly affected?: readonly SemanticTarget[];
      readonly change?: DocumentChangeSummary;
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
  /**
   * Run id for runtime-owned working copies. Immutable DocumentRef is never
   * mutated; mock/engine adapters may clone per-run state keyed by this.
   */
  readonly runId?: string;
}

export interface DocumentInspectOptions extends DocumentRuntimeOptions {
  readonly focus?: DocumentInspectFocus;
}

/**
 * Capability-based document boundary for agent-core.
 * Implementations adapt engine-client / fakes; agent-core never sees XML/OPC/NodeId.
 *
 * `find` is optional: call only when `document.find` is advertised.
 * `execute` is optional: call only when `document.mutate` (or equivalent) is advertised.
 */
export interface DocumentRuntime {
  capabilities(document: DocumentRef): RuntimeCapabilities | Promise<RuntimeCapabilities>;

  inspect(
    document: DocumentRef,
    options?: DocumentInspectOptions,
  ): Promise<InspectionResult>;

  find?(
    document: DocumentRef,
    query: DocumentFindQuery,
    options?: DocumentRuntimeOptions,
  ): Promise<FindResult>;

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

export function unsupportedCapabilityFind(
  capability: CapabilityId,
): FindResult {
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
