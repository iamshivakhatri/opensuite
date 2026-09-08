/**
 * Generic turn-scoped tool-selection boundary.
 *
 * AgentRunner asks an injected `TurnToolSelector` once per model turn for the
 * tool surface + tool-choice policy to use. This file is deliberately free of
 * any document/OpenSuite tool-name knowledge — that policy lives in
 * `document-tools/turn-tool-selector.ts` (or an application-owned selector).
 */

import type { ModelToolDefinition } from "./model.js";
import type { ToolOutcome } from "./request.js";
import type { ToolRegistry } from "./tools.js";
import type { Diagnostic, RuntimeCapabilities } from "./types.js";

/** Tool surface + tool-choice policy resolved for one model turn. */
export interface TurnToolSelection {
  /** Registry used to look up/execute any tool the model calls this turn. */
  readonly registry: ToolRegistry;
  /** Model-facing tool definitions advertised this turn (may narrow `registry`). */
  readonly toolsForModel: readonly ModelToolDefinition[];
  /** Passed through to `model.complete`. Undefined = no explicit constraint. */
  readonly toolChoice?: "auto" | "required";
  /** Advertised to `model.complete` as run/turn context. */
  readonly capabilities: RuntimeCapabilities;
}

/**
 * Inputs available to a selector when resolving this turn's tool surface.
 * Deliberately generic — no document/OpenSuite-specific fields (e.g. a
 * primary document pointer). A selector that needs run-local domain state
 * (like the current primary `DocumentRef`) must close over it itself (see
 * `document-tools/turn-tool-selector.ts`) rather than receive it here.
 */
export interface TurnToolSelectorContext {
  /** All tool outcomes so far this run (across all turns). */
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly signal: AbortSignal;
}

export type TurnToolSelectorResult =
  | ({ readonly status: "ok" } & TurnToolSelection)
  | { readonly status: "failed"; readonly diagnostic: Diagnostic };

/**
 * Injected per-turn tool-selection hook. Called once per model turn
 * (AgentRunner does not otherwise cache/interpret capability or tool-name
 * semantics); the selector itself is responsible for any internal
 * memoization (e.g. avoiding repeated capability discovery calls).
 */
export type TurnToolSelector = (
  context: TurnToolSelectorContext,
) => Promise<TurnToolSelectorResult>;
