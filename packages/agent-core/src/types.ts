/**
 * Shared primitives for agent-core contracts.
 *
 * DocumentFormat is reused from `@opensuite/contracts` so product, engine,
 * and agent agree on the Office format vocabulary. Agent-core diagnostics are
 * intentionally separate from engine `Diagnostic` (which carries engine path
 * semantics) — agent diagnostics use optional structured `details` instead.
 */

import type { DocumentFormat } from "@opensuite/contracts";

export type { DocumentFormat };

/**
 * Application-level document pointer. No storage keys, filesystem paths,
 * engine NodeIds, or XML/OPC internals.
 */
export interface DocumentRef {
  readonly documentId: string;
  readonly versionId: string;
  readonly format: DocumentFormat;
}

/**
 * Opaque application-owned target scoped to a document version.
 * Runtime adapters resolve `handle`; agent-core does not interpret it.
 *
 * Deliberately narrow — not a WordprocessingML/slide/cell addressing language.
 * Evolve later once format-neutral semantics settle.
 */
export interface SemanticTarget {
  readonly documentId: string;
  readonly versionId: string;
  /** Adapter-resolved opaque handle — never a Rust NodeId. */
  readonly handle: string;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

/**
 * Provider/runtime-neutral diagnostic. Format-neutral transport shape.
 *
 * `code` is the broad machine-readable failure class.
 * Optional `reasonCode` / `operation` / `targetHandle` are engine-authored
 * structured fields when present — pass through unchanged; never derive them
 * from `message`. Absence means unavailable (do not invent values).
 * `message` is explanatory text for humans/logs only — not for control flow.
 * `details` may carry application-owned context (e.g. STALE_HANDLE handle).
 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly reasonCode?: string;
  readonly operation?: string;
  readonly targetHandle?: string;
  readonly details?: Record<string, unknown>;
}

export type NonEmptyDiagnostics = readonly [Diagnostic, ...Diagnostic[]];

/**
 * Model-visible / persisted tool-failure projection.
 * Preserves structured engine fields when present; omits absent optionals.
 * Does not invent reasonCode/operation/targetHandle.
 */
export function shapeDiagnosticForToolResult(
  diagnostic: Diagnostic,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {
    code: diagnostic.code,
    message: diagnostic.message,
  };
  if (diagnostic.reasonCode !== undefined) {
    shaped.reasonCode = diagnostic.reasonCode;
  }
  if (diagnostic.operation !== undefined) {
    shaped.operation = diagnostic.operation;
  }
  if (diagnostic.targetHandle !== undefined) {
    shaped.targetHandle = diagnostic.targetHandle;
  }
  if (diagnostic.details !== undefined) {
    shaped.details = diagnostic.details;
  }
  return shaped;
}

/** Extensible capability identifiers (e.g. `document.inspect`). */
export type CapabilityId = string;

/**
 * Well-known capability ids. Not an exhaustive boolean bag — tools and
 * runtimes may advertise additional ids.
 */
export const Capabilities = {
  DocumentInspect: "document.inspect",
  DocumentFind: "document.find",
  DocumentMutate: "document.mutate",
  DocumentValidate: "document.validate",
  DocumentRender: "document.render",
} as const;

export interface RuntimeCapabilities {
  readonly ids: ReadonlySet<CapabilityId>;
}

/**
 * Format-neutral artifact-level affordance from the engine/runtime.
 * Global capabilities answer "is this primitive implemented?";
 * affordances answer "is it safe on this exact inspected target?".
 *
 * `reason` is an opaque machine-readable engine string (pass through).
 * TypeScript must not interpret or recompute editability from it.
 */
export interface DocumentAffordance {
  readonly capability: CapabilityId;
  readonly supported: boolean;
  readonly reason?: string;
}

export function createCapabilities(
  ...ids: readonly CapabilityId[]
): RuntimeCapabilities {
  return { ids: new Set(ids) };
}

export function hasCapability(
  capabilities: RuntimeCapabilities,
  id: CapabilityId,
): boolean {
  return capabilities.ids.has(id);
}

export function listCapabilities(
  capabilities: RuntimeCapabilities,
): readonly CapabilityId[] {
  return [...capabilities.ids].sort();
}
