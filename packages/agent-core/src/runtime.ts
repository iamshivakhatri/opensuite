import type {
  CapabilityId,
  Diagnostic,
  DocumentAffordance,
  DocumentFormat,
  DocumentRef,
  NonEmptyDiagnostics,
  RuntimeCapabilities,
  SemanticTarget,
} from "./types.js";
import { createCapabilities, hasCapability } from "./types.js";

/**
 * Optional carrier for artifact-level affordances on any inspected object.
 * Absence means the runtime did not provide target-level data — not supported
 * and not unsupported. Do not invent affordances in TypeScript.
 */
export interface InspectedArtifactAffordances {
  readonly affordances?: readonly DocumentAffordance[];
}

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
  /** Version-local occurrence when provided by the engine (not durable identity). */
  readonly occurrence?: number;
  readonly styleName?: string;
}

export interface InspectedHeading extends InspectedBlock {
  /** Present for standard Heading N styles when the engine assigns a level. */
  readonly level?: number;
}

/** Compact DOCX structure counts from engine overview inspect. */
export interface DocxInspectionOverview {
  readonly bodyBlockCount: number;
  readonly paragraphCount: number;
  readonly tableCount: number;
  readonly sectionCount: number;
}

/** Paging metadata for collection inspect focuses (engine-authoritative). */
export interface InspectionPageInfo {
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
}

/** Opaque inspected table cell — handle is artifact-local, not durable identity. */
export interface InspectedTableCell extends InspectedArtifactAffordances {
  readonly handle: string;
  readonly text: string;
}

/** Opaque inspected table column (header text + handle). */
export interface InspectedTableColumn extends InspectedArtifactAffordances {
  readonly handle: string;
  readonly text: string;
  readonly occurrence?: number;
}

/** Opaque inspected table row with per-cell handles. */
export interface InspectedTableRow extends InspectedArtifactAffordances {
  readonly handle: string;
  readonly cells: readonly InspectedTableCell[];
}

export interface InspectedTable extends InspectedArtifactAffordances {
  readonly handle: string;
  /** Version-local occurrence when provided by the engine (not durable identity). */
  readonly occurrence?: number;
  /** Engine row count (includes header row). */
  readonly rowCount: number;
  readonly cols: number;
  readonly isRectangular?: boolean;
  /** Header columns with opaque handles when the engine provides them. */
  readonly columns?: readonly InspectedTableColumn[];
  /**
   * Structured rows with opaque cell handles from the inspected artifact.
   * Prefer these handles for blank/duplicate/awkward targets.
   */
  readonly rows?: readonly InspectedTableRow[];
  /**
   * Text-only convenience grid (same order as `rows`). Prefer `rows` when
   * mutating — handles are not included here.
   */
  readonly cells?: readonly (readonly string[])[];
  /** Small preview grid when available (mock / compact views). */
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
 * Ordered direct body block from DOCX inspect focus `body_blocks`.
 * Handles are opaque and version-bound (engine uses `bN` today — do not parse).
 */
export interface InspectedBodyBlock {
  readonly handle: string;
  /** Engine kind string (e.g. paragraph | table). Pass through unchanged. */
  readonly kind: string;
  /** Visible text when the engine supplies it (paragraphs). */
  readonly text?: string;
  /** Related table handle when kind is table — optional transport field. */
  readonly tableHandle?: string;
  /** Picture details/handle when the engine supplies one. */
  readonly picture?: {
    readonly handle: string;
    readonly format: string;
    readonly widthEmu: number;
    readonly heightEmu: number;
    readonly altText?: string;
    readonly affordances?: readonly DocumentAffordance[];
  };
}

/**
 * Discriminated inspection payload. Format-specific fields can extend each arm
 * later without forcing one universal semantic tree.
 *
 * Optional collections are populated based on inspect focus — not always a
 * full document dump.
 */
/** One semantic container from a bounded DOCX context inspect. */
export interface InspectedTextContextUnit {
  readonly text: string;
  /** Engine semantic container label (e.g. paragraph, table_cell). */
  readonly container: string;
  readonly relativePosition: number;
}

export interface InspectedTextContext {
  readonly target: {
    readonly text: string;
    readonly occurrence?: number;
  };
  readonly container?: InspectedTextContextUnit;
  readonly nearby: readonly InspectedTextContextUnit[];
}

export type InspectionPayload =
  | {
      readonly format: "docx";
      readonly summary: DocumentInspectionSummary;
      /** Present for focus.kind=overview when the runtime provides counts. */
      readonly overview?: DocxInspectionOverview;
      /** Present for paged collection focuses (headings/paragraphs/tables). */
      readonly page?: InspectionPageInfo;
      readonly headings?: readonly InspectedHeading[];
      readonly paragraphs?: readonly InspectedBlock[];
      readonly tables?: readonly InspectedTable[];
      /** Ordered body blocks (paragraphs + tables) for placement-aware authoring. */
      readonly bodyBlocks?: readonly InspectedBodyBlock[];
      /**
       * Bounded text context from engine `inspect_context` (focus.kind=context).
       * Not a full document dump — target container + nearby semantic units.
       */
      readonly context?: InspectedTextContext;
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
 *
 * Real DOCX (OpenSuiteEngineAdapter) supports overview / headings / paragraphs /
 * tables / body_blocks / context. PPTX/XLSX mock runtimes support slides/sheets/range.
 * Collection focuses may include version-local offset/limit paging (max 100).
 */
export type DocumentInspectFocus =
  | { readonly kind: "overview" }
  | { readonly kind: "structure" }
  | {
      readonly kind: "headings";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "paragraphs";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "tables";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "body_blocks";
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly kind: "slides" }
  | { readonly kind: "slide"; readonly index: number }
  | { readonly kind: "sheets" }
  | { readonly kind: "range"; readonly sheet?: string; readonly address?: string }
  | {
      readonly kind: "context";
      readonly text: string;
      readonly occurrence?: number;
      readonly before?: number;
      readonly after?: number;
    };

/** Default page size for collection inspect focuses when the caller omits limit. */
export const DEFAULT_INSPECT_PAGE_LIMIT = 20;
/** Engine maximum inspect page size — never request more. */
export const MAX_INSPECT_PAGE_LIMIT = 100;

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
  | "TARGET_AMBIGUOUS"
  | "PRECONDITION_FAILED"
  | "DOCUMENT_INVALID"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | (string & {});

/**
 * Mutation result. Partial-success philosophy lives at the agent/tool
 * layer; a single operation is still success|error here.
 *
 * Verified artifact bytes (when present) are application-owned output from
 * a successful engine mutation — persistence stays outside agent-core /
 * DocumentRuntime adapters.
 */
export type OperationResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly Diagnostic[];
      readonly affected?: readonly SemanticTarget[];
      readonly change?: DocumentChangeSummary;
      /** Candidate artifact id — persistence remains outside agent-core. */
      readonly outputVersionCandidateId?: string;
      /**
       * Verified output document bytes when the runtime produced an in-memory
       * artifact. Absent on failure. Never partial/failed engine output.
       */
      readonly artifactBytes?: Uint8Array;
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
  /** Execute against caller-owned working bytes; never persists a version. */
  executeWithBytes?(
    document: DocumentRef,
    operation: DocumentOperation,
    bytes: Uint8Array,
    options?: DocumentRuntimeOptions,
  ): Promise<OperationResult>;
  /** Load the exact durable artifact for an internal working-byte session. */
  loadBytes?(document: DocumentRef): Promise<Uint8Array>;
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
