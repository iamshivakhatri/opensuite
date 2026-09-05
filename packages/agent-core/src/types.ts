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
 * Provider/runtime-neutral diagnostic. `code` is machine-readable;
 * `message` is for humans/logs only.
 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type NonEmptyDiagnostics = readonly [Diagnostic, ...Diagnostic[]];

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
