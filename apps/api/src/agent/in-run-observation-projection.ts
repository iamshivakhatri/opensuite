/**
 * Context Lifecycle C7 — deterministic in-run tool observation projection.
 *
 * Model-facing only: shrinks older large read results (document.inspect /
 * document.find) while preserving AI SDK tool-call/result pairing. The V3
 * working transcript is never mutated here.
 */

import type { ModelMessage } from "ai";

import { estimateTokens } from "./context-projection.js";

/** Latest completed tool turns kept fully verbatim. */
export const RECENT_TOOL_TURNS_VERBATIM = 2;

const COMPACTABLE_READ_TOOLS = new Set([
  "document.inspect",
  "document.find",
]);

export interface InRunObservationStats {
  /** Cumulative tool-result parts shrunk across model turns this run. */
  observationsCompacted: number;
  /** Peak estimated tokens of the in-run tool suffix before compaction. */
  estimatedInRunTokensBefore: number;
  /** Peak estimated tokens of the in-run tool suffix after compaction. */
  estimatedInRunTokensAfter: number;
  /** Peak estimated tokens of the full projected model input. */
  maxProjectedInputTokens: number;
}

export interface InRunObservationProjection {
  readonly messages: readonly ModelMessage[];
  readonly observationsCompacted: number;
  readonly estimatedInRunTokensBefore: number;
  readonly estimatedInRunTokensAfter: number;
  readonly estimatedProjectedInputTokens: number;
}

export interface InRunObservationOptions {
  /** True when the tool name is a mutate tool (API tool.kind === "mutate"). */
  readonly isMutateTool?: (toolName: string) => boolean;
}

interface ToolCallPartLike {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
}

interface ToolResultPartLike {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: {
    readonly type: string;
    readonly value?: unknown;
    readonly reason?: string;
  };
}

type Region =
  | { readonly kind: "passthrough"; readonly messages: readonly ModelMessage[] }
  | {
      readonly kind: "tool_turn";
      readonly assistant: ModelMessage;
      readonly tool: ModelMessage;
      readonly callIds: readonly string[];
      readonly toolNames: readonly string[];
    };

export function createInRunObservationStats(): InRunObservationStats {
  return {
    observationsCompacted: 0,
    estimatedInRunTokensBefore: 0,
    estimatedInRunTokensAfter: 0,
    maxProjectedInputTokens: 0,
  };
}

/** Merge one turn's projection metrics into the run accumulator (peaks + sum). */
export function accumulateInRunObservationStats(
  stats: InRunObservationStats,
  projection: InRunObservationProjection,
): void {
  stats.observationsCompacted += projection.observationsCompacted;
  stats.estimatedInRunTokensBefore = Math.max(
    stats.estimatedInRunTokensBefore,
    projection.estimatedInRunTokensBefore,
  );
  stats.estimatedInRunTokensAfter = Math.max(
    stats.estimatedInRunTokensAfter,
    projection.estimatedInRunTokensAfter,
  );
  stats.maxProjectedInputTokens = Math.max(
    stats.maxProjectedInputTokens,
    projection.estimatedProjectedInputTokens,
  );
}

/**
 * Project a transcript for the next model call: keep the latest two completed
 * tool turns verbatim; shrink older successful document.inspect / document.find
 * payloads in place. Fail-safe: malformed pairing is left unchanged.
 */
export function projectInRunObservations(
  messages: readonly ModelMessage[],
  options: InRunObservationOptions = {},
): InRunObservationProjection {
  const regions = partitionRegions(messages);
  const toolTurnIndexes: number[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    if (regions[i]!.kind === "tool_turn") toolTurnIndexes.push(i);
  }

  const estimatedInRunTokensBefore = estimateTokens(
    serializeToolTurns(regions, toolTurnIndexes),
  );

  if (toolTurnIndexes.length <= RECENT_TOOL_TURNS_VERBATIM) {
    const estimatedProjectedInputTokens = estimateMessagesTokens(messages);
    return {
      messages,
      observationsCompacted: 0,
      estimatedInRunTokensBefore,
      estimatedInRunTokensAfter: estimatedInRunTokensBefore,
      estimatedProjectedInputTokens,
    };
  }

  const isMutateTool =
    options.isMutateTool ?? ((name: string) => isDefaultMutateToolName(name));

  const recentStart =
    toolTurnIndexes.length - RECENT_TOOL_TURNS_VERBATIM;
  const recentRegionIndexes = new Set(
    toolTurnIndexes.slice(recentStart),
  );

  // First successful mutation turn (by region index) — older reads before it
  // are stale-handle candidates once outside the verbatim window.
  let firstSuccessfulMutationRegion = -1;
  for (const idx of toolTurnIndexes) {
    const region = regions[idx]!;
    if (region.kind !== "tool_turn") continue;
    if (toolTurnHasSuccessfulMutation(region, isMutateTool)) {
      firstSuccessfulMutationRegion = idx;
      break;
    }
  }

  let observationsCompacted = 0;
  const projectedRegions = regions.map((region, regionIndex) => {
    if (region.kind !== "tool_turn") return region;
    if (recentRegionIndexes.has(regionIndex)) return region;

    const preMutationStale =
      firstSuccessfulMutationRegion >= 0 &&
      regionIndex < firstSuccessfulMutationRegion;

    const compacted = compactToolTurn(region, {
      isMutateTool,
      aggressiveReadCompaction: preMutationStale,
    });
    observationsCompacted += compacted.compactedCount;
    return compacted.region;
  });

  const projectedMessages = flattenRegions(projectedRegions);
  const estimatedInRunTokensAfter = estimateTokens(
    serializeToolTurns(projectedRegions, toolTurnIndexes),
  );
  const estimatedProjectedInputTokens = estimateMessagesTokens(projectedMessages);

  return {
    messages: projectedMessages,
    observationsCompacted,
    estimatedInRunTokensBefore,
    estimatedInRunTokensAfter,
    estimatedProjectedInputTokens,
  };
}

function partitionRegions(messages: readonly ModelMessage[]): Region[] {
  const regions: Region[] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i]!;
    const next = messages[i + 1];
    const paired = tryParseToolTurn(current, next);
    if (paired) {
      regions.push(paired);
      i += 2;
      continue;
    }
    // Fail-safe: single message or unpaired assistant/tool stays passthrough.
    const passthrough: ModelMessage[] = [current];
    i += 1;
    while (i < messages.length) {
      const peek = messages[i]!;
      const peekNext = messages[i + 1];
      if (tryParseToolTurn(peek, peekNext)) break;
      passthrough.push(peek);
      i += 1;
    }
    regions.push({ kind: "passthrough", messages: passthrough });
  }
  return regions;
}

function tryParseToolTurn(
  assistant: ModelMessage | undefined,
  tool: ModelMessage | undefined,
): Extract<Region, { kind: "tool_turn" }> | null {
  if (!assistant || !tool) return null;
  if (assistant.role !== "assistant" || tool.role !== "tool") return null;
  if (!Array.isArray(assistant.content) || !Array.isArray(tool.content)) {
    return null;
  }

  const calls = (assistant.content as readonly unknown[]).filter(isToolCallPart);
  if (calls.length === 0) return null;

  const results = (tool.content as readonly unknown[]).filter(isToolResultPart);
  if (results.length === 0) return null;

  const callIds = calls.map((call) => call.toolCallId);
  const callIdSet = new Set(callIds);
  if (callIdSet.size !== callIds.length) return null;

  // Every call must have exactly one matching result; no orphans either way.
  if (results.length !== callIds.length) return null;
  const resultIds = new Set(results.map((result) => result.toolCallId));
  for (const id of callIds) {
    if (!resultIds.has(id)) return null;
  }
  for (const id of resultIds) {
    if (!callIdSet.has(id)) return null;
  }

  // toolName on results should match the call of the same id when both present.
  const callNameById = new Map(
    calls.map((call) => [call.toolCallId, call.toolName] as const),
  );
  for (const result of results) {
    const expected = callNameById.get(result.toolCallId);
    if (expected !== undefined && expected !== result.toolName) return null;
  }

  return {
    kind: "tool_turn",
    assistant,
    tool,
    callIds,
    toolNames: calls.map((call) => call.toolName),
  };
}

function compactToolTurn(
  region: Extract<Region, { kind: "tool_turn" }>,
  options: {
    readonly isMutateTool: (name: string) => boolean;
    readonly aggressiveReadCompaction: boolean;
  },
): {
  readonly region: Extract<Region, { kind: "tool_turn" }>;
  readonly compactedCount: number;
} {
  if (region.tool.role !== "tool" || !Array.isArray(region.tool.content)) {
    return { region, compactedCount: 0 };
  }

  let compactedCount = 0;
  const sourceContent = region.tool.content as readonly unknown[];
  const nextContent = sourceContent.map((part) => {
    if (!isToolResultPart(part)) return part;
    const compacted = maybeCompactResult(part, options);
    if (compacted === part) return part;
    compactedCount += 1;
    return compacted;
  });

  if (compactedCount === 0) return { region, compactedCount: 0 };

  return {
    region: {
      ...region,
      tool: {
        role: "tool" as const,
        content: nextContent,
      } as ModelMessage,
    },
    compactedCount,
  };
}

function maybeCompactResult(
  part: ToolResultPartLike,
  options: {
    readonly isMutateTool: (name: string) => boolean;
    readonly aggressiveReadCompaction: boolean;
  },
): ToolResultPartLike {
  const toolName = part.toolName;

  // Never rewrite mutation / lifecycle / finish / unknown small tools in C7,
  // except we may still leave them untouched when they are mutate results.
  if (options.isMutateTool(toolName)) {
    return part;
  }
  if (!COMPACTABLE_READ_TOOLS.has(toolName)) {
    return part;
  }

  const payload = readResultPayload(part);
  if (payload === undefined) return part;

  const ok = payload.ok;
  if (ok === false) {
    // Conservative: only shrink failed reads when failure fields survive.
    const stub = compactFailedReadStub(toolName, payload);
    if (!stub) return part;
    return replaceJsonOutput(part, stub);
  }

  // Successful compactable reads — always eligible outside the verbatim window.
  // aggressiveReadCompaction (pre-mutation stale) uses the same stub; it exists
  // so callers can treat those as preferred candidates without a second policy.
  void options.aggressiveReadCompaction;

  if (toolName === "document.inspect") {
    return replaceJsonOutput(part, compactInspectStub(payload));
  }
  if (toolName === "document.find") {
    return replaceJsonOutput(part, compactFindStub(payload));
  }
  return part;
}

function compactInspectStub(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    ok: true,
    compacted: true,
    tool: "document.inspect",
  };
  // Engine results use a top-level focus string (e.g. "tables").
  const focusField =
    typeof payload.focus === "string"
      ? payload.focus
      : inferInspectFocus(payload);
  if (focusField) stub.focus = focusField;

  const summary = summarizeInspectCounts(payload);
  if (summary) stub.summary = summary;
  return stub;
}

function inferInspectFocus(payload: Record<string, unknown>): string | undefined {
  for (const key of [
    "overview",
    "headings",
    "paragraphs",
    "tables",
    "body_blocks",
    "bodyBlocks",
    "context",
  ] as const) {
    if (payload[key] !== undefined) {
      return key === "bodyBlocks" ? "body_blocks" : key;
    }
  }
  return undefined;
}

function summarizeInspectCounts(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const summary: Record<string, unknown> = {};
  const overview = payload.overview;
  if (overview && typeof overview === "object") {
    const o = overview as Record<string, unknown>;
    for (const key of [
      "bodyBlockCount",
      "paragraphCount",
      "tableCount",
      "sectionCount",
    ] as const) {
      if (typeof o[key] === "number") summary[key] = o[key];
    }
  }
  for (const [field, outKey] of [
    ["paragraphs", "paragraphTotal"],
    ["headings", "headingTotal"],
    ["tables", "tableTotal"],
    ["body_blocks", "bodyBlockTotal"],
    ["bodyBlocks", "bodyBlockTotal"],
  ] as const) {
    const page = (payload[field] as { page?: { total?: unknown } } | undefined)
      ?.page;
    if (page && typeof page.total === "number") summary[outKey] = page.total;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function compactFindStub(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    ok: true,
    compacted: true,
    tool: "document.find",
  };
  if (typeof payload.query === "string") stub.query = payload.query;
  if (typeof payload.matchCount === "number") {
    stub.matchCount = payload.matchCount;
  } else if (Array.isArray(payload.matches)) {
    stub.matchCount = payload.matches.length;
  }
  return stub;
}

function compactFailedReadStub(
  toolName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const reasonCode =
    typeof payload.reasonCode === "string" ? payload.reasonCode : undefined;
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics
    : undefined;
  const primary =
    diagnostics &&
    diagnostics[0] &&
    typeof diagnostics[0] === "object" &&
    diagnostics[0] !== null
      ? (diagnostics[0] as Record<string, unknown>)
      : undefined;
  const primaryReason =
    (typeof primary?.message === "string" ? primary.message : undefined) ??
    (typeof primary?.reasonCode === "string" ? primary.reasonCode : undefined) ??
    (typeof primary?.code === "string" ? primary.code : undefined);

  if (!reasonCode && !primaryReason) {
    // Cannot preserve a useful failure signal — leave verbatim.
    return null;
  }

  const stub: Record<string, unknown> = {
    ok: false,
    compacted: true,
    tool: toolName,
  };
  if (reasonCode) stub.reasonCode = reasonCode;
  if (primaryReason) stub.reason = primaryReason;
  return stub;
}

function toolTurnHasSuccessfulMutation(
  region: Extract<Region, { kind: "tool_turn" }>,
  isMutateTool: (name: string) => boolean,
): boolean {
  if (region.tool.role !== "tool" || !Array.isArray(region.tool.content)) {
    return false;
  }
  for (const part of region.tool.content) {
    if (!isToolResultPart(part)) continue;
    if (!isMutateTool(part.toolName)) continue;
    const payload = readResultPayload(part);
    if (payload && payload.ok === true) return true;
    // Mutation success without explicit ok (unlikely) — treat presence of
    // versionId as success signal used by bound-docx.
    if (
      payload &&
      payload.ok !== false &&
      (typeof payload.versionId === "string" ||
        typeof payload.versionNumber === "number")
    ) {
      return true;
    }
  }
  return false;
}

function readResultPayload(
  part: ToolResultPartLike,
): Record<string, unknown> | undefined {
  const output = part.output;
  if (output.type === "json" && output.value !== null && typeof output.value === "object") {
    return output.value as Record<string, unknown>;
  }
  if (output.type === "error-json" && output.value !== null && typeof output.value === "object") {
    return { ok: false, ...(output.value as Record<string, unknown>) };
  }
  if (output.type === "error-text" && typeof output.value === "string") {
    return { ok: false, reason: output.value };
  }
  if (output.type === "text" && typeof output.value === "string") {
    try {
      const parsed: unknown = JSON.parse(output.value);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function replaceJsonOutput(
  part: ToolResultPartLike,
  value: Record<string, unknown>,
): ToolResultPartLike {
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: { type: "json", value },
  };
}

function isDefaultMutateToolName(toolName: string): boolean {
  if (toolName === "document.inspect" || toolName === "document.find") {
    return false;
  }
  if (toolName === "finish") return false;
  if (toolName.startsWith("workspace.")) return false;
  return toolName.startsWith("document.");
}

function isToolCallPart(value: unknown): value is ToolCallPartLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "tool-call" &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string" &&
    typeof (value as { toolName?: unknown }).toolName === "string"
  );
}

function isToolResultPart(value: unknown): value is ToolResultPartLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "tool-result" &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string" &&
    typeof (value as { toolName?: unknown }).toolName === "string" &&
    typeof (value as { output?: unknown }).output === "object" &&
    (value as { output: unknown }).output !== null
  );
}

function flattenRegions(regions: readonly Region[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const region of regions) {
    if (region.kind === "passthrough") {
      out.push(...region.messages);
    } else {
      out.push(region.assistant, region.tool);
    }
  }
  return out;
}

function serializeToolTurns(
  regions: readonly Region[],
  toolTurnIndexes: readonly number[],
): string {
  const parts: unknown[] = [];
  for (const idx of toolTurnIndexes) {
    const region = regions[idx]!;
    if (region.kind !== "tool_turn") continue;
    parts.push(region.assistant, region.tool);
  }
  return JSON.stringify(parts);
}

function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  return estimateTokens(JSON.stringify(messages));
}
