/**
 * Run-local progress ledger for document-agent policy.
 *
 * Tracks whether tool turns made state/knowledge progress vs redundant reads.
 * Domain-owned — AgentRunner stays agnostic.
 */

import { agentDebugLifecycle } from "../debug-lifecycle.js";
import type { AgentEventSink } from "../events.js";
import {
  DEFAULT_INSPECT_PAGE_LIMIT,
  type DocumentInspectFocus,
  type InspectionPageInfo,
} from "../runtime.js";
import type { DocumentRef } from "../types.js";
import { DOCUMENT_TOOL_NAMES } from "./names.js";

export type ProgressClassification =
  | "STATE_PROGRESS"
  | "KNOWLEDGE_PROGRESS"
  | "REDUNDANT_READ"
  | "FAILURE";

/** Normalized paging coverage for one inspect focus kind on the current version. */
export interface InspectCoverageEntry {
  readonly kind: string;
  readonly offset: number;
  readonly limit: number;
  readonly total?: number;
  readonly returned?: number;
  readonly hasMore?: boolean;
}

export interface DocumentProgressLedger {
  /** Monotonic model-turn counter (incremented by the turn selector). */
  turnIndex: number;
  lastStateProgressTurn: number | null;
  lastKnowledgeProgressTurn: number | null;
  /** Canonical inspect signatures already satisfied for the current version. */
  satisfiedInspectSignatures: Set<string>;
  knownInspectCoverage: InspectCoverageEntry[];
  redundantReadCount: number;
  lastRedundantSignature: string | null;
  /** Compact next-turn directive; cleared on state/knowledge progress. */
  pendingStagnationGuidance: string | null;
}

export function createProgressLedger(): DocumentProgressLedger {
  return {
    turnIndex: 0,
    lastStateProgressTurn: null,
    lastKnowledgeProgressTurn: null,
    satisfiedInspectSignatures: new Set(),
    knownInspectCoverage: [],
    redundantReadCount: 0,
    lastRedundantSignature: null,
    pendingStagnationGuidance: null,
  };
}

export function noteModelTurn(ledger: DocumentProgressLedger): void {
  ledger.turnIndex += 1;
}

export function noteStateProgress(ledger: DocumentProgressLedger): void {
  ledger.lastStateProgressTurn = ledger.turnIndex;
  ledger.pendingStagnationGuidance = null;
  ledger.lastRedundantSignature = null;
}

export function clearInspectKnowledge(ledger: DocumentProgressLedger): void {
  ledger.satisfiedInspectSignatures.clear();
  ledger.knownInspectCoverage = [];
  ledger.lastRedundantSignature = null;
  ledger.pendingStagnationGuidance = null;
}

/**
 * Normalize inspect focus so omitted paging matches engine defaults.
 * Only proven-equivalent defaults — no semantic guessing.
 */
export function normalizeInspectFocus(
  focus: DocumentInspectFocus | undefined,
): DocumentInspectFocus {
  if (!focus) return { kind: "overview" };
  if (
    focus.kind === "paragraphs" ||
    focus.kind === "headings" ||
    focus.kind === "tables" ||
    focus.kind === "body_blocks"
  ) {
    return {
      kind: focus.kind,
      offset: focus.offset ?? 0,
      limit: focus.limit ?? DEFAULT_INSPECT_PAGE_LIMIT,
    };
  }
  return focus;
}

export function inspectReadSignature(
  focus: DocumentInspectFocus | undefined,
): string {
  return `${DOCUMENT_TOOL_NAMES.inspect}:${stableJson(normalizeInspectFocus(focus))}`;
}

export function isInspectKnowledgeSatisfied(
  ledger: DocumentProgressLedger,
  focus: DocumentInspectFocus | undefined,
): boolean {
  return ledger.satisfiedInspectSignatures.has(inspectReadSignature(focus));
}

export function noteKnowledgeProgress(
  ledger: DocumentProgressLedger,
  focus: DocumentInspectFocus | undefined,
  inspection: unknown,
): InspectCoverageEntry {
  const signature = inspectReadSignature(focus);
  const coverage = coverageFromInspection(focus, inspection);
  ledger.satisfiedInspectSignatures.add(signature);
  ledger.knownInspectCoverage = [
    ...ledger.knownInspectCoverage.filter(
      (entry) =>
        !(
          entry.kind === coverage.kind &&
          entry.offset === coverage.offset &&
          entry.limit === coverage.limit
        ),
    ),
    coverage,
  ];
  ledger.lastKnowledgeProgressTurn = ledger.turnIndex;
  ledger.pendingStagnationGuidance = null;
  ledger.lastRedundantSignature = null;
  return coverage;
}

export function noteRedundantInspect(
  ledger: DocumentProgressLedger,
  focus: DocumentInspectFocus | undefined,
): {
  readonly signature: string;
  readonly coverage: InspectCoverageEntry | undefined;
  readonly nextOffset: number | undefined;
  readonly guidance: string;
  readonly output: RedundantInspectOutput;
} {
  const signature = inspectReadSignature(focus);
  const normalized = normalizeInspectFocus(focus);
  const coverage =
    ledger.knownInspectCoverage.find(
      (entry) =>
        entry.kind === coverageKind(normalized) &&
        entry.offset === pagingOffset(normalized) &&
        entry.limit === pagingLimit(normalized),
    ) ?? coverageFromFocus(normalized);
  const nextOffset = nextUnreadOffset(coverage);
  const guidance = buildStagnationGuidance(coverage, nextOffset);
  ledger.redundantReadCount += 1;
  ledger.lastRedundantSignature = signature;
  ledger.pendingStagnationGuidance = guidance;
  const output: RedundantInspectOutput = {
    progress: "REDUNDANT_READ",
    message: describeRedundantCoverage(coverage, nextOffset),
    focus: normalized,
    coverage,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
  return { signature, coverage, nextOffset, guidance, output };
}

export interface RedundantInspectOutput {
  readonly progress: "REDUNDANT_READ";
  readonly message: string;
  readonly focus: DocumentInspectFocus;
  readonly coverage: InspectCoverageEntry;
  readonly nextOffset?: number;
}

export function turnsSince(
  ledger: DocumentProgressLedger,
  lastTurn: number | null,
): number | null {
  if (lastTurn === null) return null;
  return Math.max(0, ledger.turnIndex - lastTurn);
}

export function emitProgressEvent(
  events: AgentEventSink | undefined,
  input: {
    readonly runId: string;
    readonly classification: ProgressClassification;
    readonly document?: DocumentRef | null;
    readonly readSignature?: string;
    readonly coverage?: InspectCoverageEntry;
    readonly nextOffset?: number;
    readonly ledger: DocumentProgressLedger;
  },
): void {
  const {
    runId,
    classification,
    document,
    readSignature,
    coverage,
    nextOffset,
    ledger,
  } = input;
  const payload = {
    classification,
    ...(document
      ? { documentId: document.documentId, versionId: document.versionId }
      : {}),
    ...(readSignature !== undefined ? { readSignature } : {}),
    ...(coverage !== undefined ? { knownCoverage: coverage } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    turnsSinceStateProgress: turnsSince(ledger, ledger.lastStateProgressTurn),
    turnsSinceKnowledgeProgress: turnsSince(
      ledger,
      ledger.lastKnowledgeProgressTurn,
    ),
    redundantReadCount: ledger.redundantReadCount,
    turnIndex: ledger.turnIndex,
  };
  agentDebugLifecycle("PROGRESS", payload);
  void events?.emit({
    type: "agent.progress",
    runId,
    at: new Date().toISOString(),
    ...payload,
  });
}

function coverageFromInspection(
  focus: DocumentInspectFocus | undefined,
  inspection: unknown,
): InspectCoverageEntry {
  const base = coverageFromFocus(normalizeInspectFocus(focus));
  const page = extractPageInfo(inspection);
  if (!page) return base;
  return {
    kind: base.kind,
    offset: page.offset,
    limit: base.limit,
    total: page.total,
    returned: page.returned,
    hasMore: page.hasMore,
  };
}

function coverageFromFocus(focus: DocumentInspectFocus): InspectCoverageEntry {
  return {
    kind: coverageKind(focus),
    offset: pagingOffset(focus),
    limit: pagingLimit(focus),
  };
}

function coverageKind(focus: DocumentInspectFocus): string {
  return focus.kind;
}

function pagingOffset(focus: DocumentInspectFocus): number {
  return "offset" in focus && typeof focus.offset === "number" ? focus.offset : 0;
}

function pagingLimit(focus: DocumentInspectFocus): number {
  return "limit" in focus && typeof focus.limit === "number"
    ? focus.limit
    : DEFAULT_INSPECT_PAGE_LIMIT;
}

function extractPageInfo(inspection: unknown): InspectionPageInfo | undefined {
  if (!inspection || typeof inspection !== "object") return undefined;
  const payload = (inspection as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const page = (payload as { page?: unknown }).page;
  if (!page || typeof page !== "object") return undefined;
  const record = page as Record<string, unknown>;
  if (
    typeof record.total !== "number" ||
    typeof record.offset !== "number" ||
    typeof record.returned !== "number" ||
    typeof record.hasMore !== "boolean"
  ) {
    return undefined;
  }
  return {
    total: record.total,
    offset: record.offset,
    returned: record.returned,
    hasMore: record.hasMore,
  };
}

function nextUnreadOffset(coverage: InspectCoverageEntry): number | undefined {
  if (coverage.hasMore !== true) return undefined;
  const returned = coverage.returned ?? coverage.limit;
  return coverage.offset + returned;
}

function describeRedundantCoverage(
  coverage: InspectCoverageEntry,
  nextOffset: number | undefined,
): string {
  const end = coverage.offset + (coverage.returned ?? coverage.limit) - 1;
  const label = coverage.kind.replace(/_/g, " ");
  const range = `${label} ${coverage.offset}–${Math.max(coverage.offset, end)}`;
  const ofTotal =
    coverage.total !== undefined ? ` of ${coverage.total}` : "";
  if (nextOffset !== undefined) {
    return (
      `${range}${ofTotal} are already available for the current document version. ` +
      `More content exists; next unread offset is ${nextOffset}.`
    );
  }
  return `${range}${ofTotal} are already available for the current document version.`;
}

function buildStagnationGuidance(
  coverage: InspectCoverageEntry,
  nextOffset: number | undefined,
): string {
  const base =
    "Runtime policy: the requested document information is already available and produced no new progress. " +
    "Do not repeat the same read. Inspect a different uncovered scope if necessary, " +
    "perform the next required action, or finish if the task is complete.";
  if (nextOffset === undefined) return base;
  const label = coverage.kind.replace(/_/g, " ");
  return `${base} Next unread ${label} offset: ${nextOffset}.`;
}

/** Deterministic JSON for canonical signatures (mirrors runner toolFailureKey). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}
