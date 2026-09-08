/**
 * OpenSuite/document-owned per-run state.
 *
 * `AgentRunner` externalized primary-document + artifact-handle ownership in
 * AgentCore v2 Step 3 — it no longer knows what a `DocumentRef` or
 * `ArtifactHandleRegistry` is. This module is the small run-local state
 * object + closures that replace what used to be `RunDocumentState` inline
 * in the runner:
 *
 *   createDocumentRunState()       — mutable { primary, handles } for one run
 *   createDocumentToolContext(...) — `CreateToolExecutionContext` closure
 *                                    over that state (per-tool-execution
 *                                    `ToolExecutionContext`, always reading
 *                                    the *current* primary/handles)
 *
 * `createDocumentTurnToolSelector` (`./turn-tool-selector.ts`) reads the same
 * state object's `.primary` for capability discovery, so a write's
 * `advancePrimaryDocument` call is immediately visible to both the next tool
 * execution and the next turn's tool-selection — with no involvement from
 * AgentRunner.
 */

import { ArtifactHandleRegistry } from "../artifact-handles.js";
import type { DocumentMutationExecutor } from "../document-mutation.js";
import type { CreateToolExecutionContext } from "../model.js";
import type { DocumentRuntime } from "../runtime.js";
import type { DocumentRef } from "../types.js";

/** Run-scoped mutable pointer to the active primary document version + handles. */
export interface DocumentRunState {
  primary: DocumentRef | null;
  readonly handles: ArtifactHandleRegistry;
}

/** Create fresh per-run document state. Scoped to one `AgentRunner.run()` call. */
export function createDocumentRunState(
  primary: DocumentRef | null = null,
): DocumentRunState {
  return { primary, handles: new ArtifactHandleRegistry() };
}

export interface DocumentToolContextOptions {
  readonly state: DocumentRunState;
  readonly runtime?: DocumentRuntime;
  readonly mutations?: DocumentMutationExecutor;
}

/**
 * Build the `CreateToolExecutionContext` factory AgentRunner calls once per
 * tool execution. Reads `state.primary`/`state.handles` fresh every call (not
 * captured once) so sequential writes in the same assistant response observe
 * N, then N+1, then N+2 — and installs `advancePrimaryDocument` so a write
 * mutates the same shared state the selector and subsequent tool calls read.
 */
export function createDocumentToolContext(
  options: DocumentToolContextOptions,
): CreateToolExecutionContext {
  const { state, runtime, mutations } = options;
  return (base) => ({
    runId: base.runId,
    signal: base.signal,
    events: base.events,
    primaryDocument: state.primary,
    runtime,
    mutations,
    advancePrimaryDocument: (document: DocumentRef) => {
      state.primary = document;
    },
    handles: state.handles,
  });
}
