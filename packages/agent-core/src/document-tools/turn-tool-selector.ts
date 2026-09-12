/**
 * OpenSuite document-aware `TurnToolSelector` (see `../turn-tools.ts`).
 *
 * Owns every document/OpenSuite-specific tool-selection policy that used to
 * live inline in `AgentRunner`:
 *   - capability discovery (once per primary documentId; cached across turns)
 *   - capability-filtered document tool catalog
 *   - workspace + document tool composition
 *   - post-create authoring narrowing
 *   - create/write force-tools tool-choice policy
 *
 * AgentRunner only knows it received a `TurnToolSelection`; it does not
 * interpret capability ids or tool names itself.
 */

import type { DocumentMutationExecutor } from "../document-mutation.js";
import type {
  AgentTool,
  CreateToolExecutionContext,
  ModelToolDefinition,
} from "../model.js";
import { toolEffect } from "../model.js";
import type { ToolOutcome } from "../request.js";
import { transformContext } from "../model-context.js";
import type {
  ModelTimeoutContext,
  ToolBatchContext,
  ToolTurnLifecycle,
  TransformAgentContext,
} from "../runner.js";
import type { DocumentRuntime } from "../runtime.js";
import { ToolRegistry } from "../tools.js";
import type { AgentEventSink } from "../events.js";
import type {
  TurnToolSelector,
  TurnToolSelectorResult,
} from "../turn-tools.js";
import {
  createCapabilities,
  type Diagnostic,
  type DocumentRef,
  type RuntimeCapabilities,
} from "../types.js";
import { filterDocumentToolsByCapabilities } from "./index.js";
import {
  advanceDocumentWorkingState,
  createDocumentRunState,
  createDocumentToolContext,
  type DocumentRunState,
} from "./run-state.js";

type DocumentToolFamily = "read" | "content" | "formatting" | "tables" | "layout" | "media";

/** One source of truth for model-facing document-tool relevance. */
const DOCUMENT_TOOL_FAMILIES: Record<string, DocumentToolFamily> = {
  "document.inspect": "read", "document.find": "read",
  "document.replace_text": "content", "document.insert_paragraph": "content",
  "document.insert_paragraphs": "content", "document.delete_paragraph": "content",
  "document.set_content_control_text": "content", "document.set_hyperlink": "content",
  "document.set_paragraph_style": "formatting", "document.set_paragraph_formatting": "formatting",
  "document.set_text_formatting": "formatting", "document.set_paragraphs_list": "formatting",
  "document.set_table_formatting": "formatting", "document.set_table_column_widths": "formatting",
  "document.set_table_cell_shading": "formatting",
  "document.create_table": "content", "document.set_table_cells_text": "tables",
  "document.insert_table_rows": "tables", "document.insert_table_row": "tables",
  "document.insert_table_column": "tables", "document.delete_table": "tables",
  "document.delete_table_row": "tables", "document.delete_table_column": "tables",
  "document.insert_page_break": "layout", "document.delete_page_break": "layout",
  "document.set_page_setup": "layout", "document.set_header_footer_text": "layout",
  "document.set_page_number": "layout",
  "document.insert_picture": "media", "document.delete_picture": "media",
  "document.set_picture_size": "media", "document.replace_picture": "media",
  "slides.update_text": "content", "workbook.set_cells": "content",
};

const DEFAULT_WORKING_FAMILIES = new Set<DocumentToolFamily>([
  "read", "content", "formatting",
]);

/** Blank-document creation tool name (workspace-owned, not a document tool). */
const CREATE_BLANK_TOOL = "workspace.create_blank_docx";

const AUTHORING_TIMEOUT_RETRY_MESSAGE =
  "Runtime policy: previous authoring model turn timed out. " +
  "Call tools now with a compact first pass only: document.insert_paragraphs " +
  "(structured semantic units: title + short intro / outline), " +
  "document.set_paragraph_style for hierarchy on the title, " +
  "and one document.create_table with at most 6–8 rows if the content is tabular. " +
  "Do not generate a giant single payload — continue remaining sections in later turns.";

const USE_DOCUMENT_TOOLS_NUDGE_MESSAGE =
  "Runtime policy: you must use tools for document work — do not put the document body in chat. " +
  "If the user wants a NEW document, call workspace.create_blank_docx alone first. " +
  "If editing the already-open document, use inspect / set_paragraph_style / mutation tools as needed — do not create another blank file. " +
  "Short confirmation text only after tools succeed.";

/**
 * After blank create, only advertise core authoring tools until the first
 * write lands. A full catalog + tool_choice=required can hang slow models
 * for minutes while they stall before the first token.
 * Includes style/spacing/list so deliberate presentation can land with content.
 */
const POST_CREATE_AUTHORING_TOOL_NAMES = new Set<string>([
  "document.insert_paragraph",
  "document.insert_paragraphs",
  "document.create_table",
  "document.set_table_cells_text",
  "document.set_paragraph_style",
  "document.set_paragraph_formatting",
  "document.set_paragraphs_list",
]);

export interface DocumentTurnToolSelectorOptions {
  /** Non-document / always-on tools (e.g. workspace.create_blank_docx). */
  readonly baseTools: ToolRegistry;
  /** Full model-facing document tool catalog (unfiltered). */
  readonly documentToolCatalog: readonly AgentTool[];
  readonly runtime?: DocumentRuntime;
  /**
   * OpenSuite-owned run state (see `./run-state.js`). The selector reads
   * `state.primary` itself on every call instead of receiving it from
   * AgentRunner — this is what keeps `TurnToolSelectorContext` generic.
   * A tool execution that calls `advancePrimaryDocument` mutates this same
   * object, so the next turn's selector call observes the new primary.
   */
  readonly state: DocumentRunState;
}

/**
 * Build a `TurnToolSelector` that reproduces the original AgentRunner
 * bootstrap + per-turn selection behavior verbatim:
 *   primary DocumentRef → DocumentRuntime.capabilities() → filter catalog
 *   → merge with base tools → narrow/force per create+write state.
 *
 * Capability discovery is memoized by primary `documentId` — re-run only
 * when the primary document identity changes (e.g. after workspace create).
 */
export function createDocumentTurnToolSelector(
  options: DocumentTurnToolSelectorOptions,
): TurnToolSelector {
  const { baseTools, documentToolCatalog, runtime, state } = options;

  let bootstrappedPrimaryId: string | null | undefined = undefined;
  let cachedRegistry: ToolRegistry = baseTools;
  let cachedCapabilities: RuntimeCapabilities = createCapabilities();

  async function bootstrap(
    primary: DocumentRef | null,
  ): Promise<{ status: "ok" } | { status: "failed"; diagnostic: Diagnostic }> {
    if (!primary) {
      // No primary document → only tools that need no capability.
      const filtered = filterDocumentToolsByCapabilities(
        documentToolCatalog,
        createCapabilities(),
      );
      cachedRegistry = ToolRegistry.create([...baseTools.list(), ...filtered]);
      cachedCapabilities = createCapabilities();
      return { status: "ok" };
    }

    if (!runtime) {
      return {
        status: "failed",
        diagnostic: {
          code: "CAPABILITY_DISCOVERY_FAILED",
          severity: "error",
          message:
            "DocumentRuntime is required to discover document tools for this run",
          details: {
            documentId: primary.documentId,
            versionId: primary.versionId,
            format: primary.format,
          },
        },
      };
    }

    let capabilities: RuntimeCapabilities;
    try {
      capabilities = await runtime.capabilities(primary);
    } catch (error) {
      return {
        status: "failed",
        diagnostic: {
          code: "CAPABILITY_DISCOVERY_FAILED",
          severity: "error",
          message: "Failed to discover document runtime capabilities",
          details: {
            documentId: primary.documentId,
            versionId: primary.versionId,
            format: primary.format,
            cause:
              error instanceof Error
                ? error.message
                : "unknown discovery error",
          },
        },
      };
    }

    const documentTools = filterDocumentToolsByCapabilities(
      documentToolCatalog,
      capabilities,
    );
    cachedRegistry = ToolRegistry.create([
      ...baseTools.list(),
      ...documentTools,
    ]);
    cachedCapabilities = capabilities;
    return { status: "ok" };
  }

  return async (context): Promise<TurnToolSelectorResult> => {
    const currentPrimaryId = state.primary?.documentId ?? null;
    if (
      bootstrappedPrimaryId === undefined ||
      currentPrimaryId !== bootstrappedPrimaryId
    ) {
      const result = await bootstrap(state.primary);
      if (result.status === "failed") {
        return result;
      }
      bootstrappedPrimaryId = currentPrimaryId;
    }

    return {
      status: "ok",
      registry: cachedRegistry,
      toolsForModel: selectToolsForModel(cachedRegistry, context.toolOutcomes, state),
      toolChoice: resolveToolChoice(cachedRegistry, context.toolOutcomes),
      capabilities: cachedCapabilities,
    };
  };
}

export interface DocumentAgentRunnerOptionsInput {
  /** Non-document / always-on tools (e.g. workspace.create_blank_docx). */
  readonly tools: ToolRegistry;
  /** Full model-facing document tool catalog (unfiltered). */
  readonly documentToolCatalog: readonly AgentTool[];
  readonly runtime?: DocumentRuntime;
  readonly mutations?: DocumentMutationExecutor;
  /** Initial primary document for this run, if any. */
  readonly primaryDocument?: DocumentRef | null;
}

/**
 * Convenience: build the document-aware `AgentRunnerOptions` fields from one
 * call, wiring a
 * single fresh `DocumentRunState` through both the turn selector and the
 * per-tool-execution context factory. Equivalent to constructing
 * `createDocumentRunState` + `createDocumentTurnToolSelector` +
 * `createDocumentToolContext` by hand.
 */
export function createDocumentAgentRunnerOptions(
  input: DocumentAgentRunnerOptionsInput,
): {
  readonly tools: ToolRegistry;
  readonly selectTurnTools: TurnToolSelector;
  readonly createToolContext: CreateToolExecutionContext;
  readonly transformContext: TransformAgentContext;
  readonly shouldTerminalizeToolBatch: (context: ToolBatchContext) => boolean;
  readonly toolTurnLifecycle?: ToolTurnLifecycle;
  readonly getModelTimeoutRetryMessage: (
    context: ModelTimeoutContext,
  ) => string | undefined;
  readonly requiredToolsNudgeMessage: string;
} {
  const state = createDocumentRunState(input.primaryDocument ?? null);
  return {
    tools: input.tools,
    selectTurnTools: createDocumentTurnToolSelector({
      baseTools: input.tools,
      documentToolCatalog: input.documentToolCatalog,
      runtime: input.runtime,
      state,
    }),
    createToolContext: createDocumentToolContext({
      state,
      runtime: input.runtime,
      mutations: input.mutations,
    }),
    toolTurnLifecycle: createDocumentToolTurnLifecycle(state, input.mutations),
    ...createDocumentAgentRunnerPolicyOptions(state),
  };
}

function createDocumentToolTurnLifecycle(
  state: DocumentRunState,
  mutations: DocumentMutationExecutor | undefined,
): ToolTurnLifecycle | undefined {
  if (!mutations?.flushPendingFormatting) return undefined;
  const pendingMutations = mutations;
  let priorFlush: Exclude<Awaited<ReturnType<NonNullable<DocumentMutationExecutor["flushPendingFormatting"]>>>, { status: "noop" }> | undefined;
  async function flush(context: { readonly runId: string; readonly events: AgentEventSink }) {
    const flushed = await pendingMutations.flushPendingFormatting!();
    if (flushed.status !== "success") return flushed;
    priorFlush = flushed;
    advanceDocumentWorkingState(state, flushed.document, true);
    await context.events.emit({
      type: "document.version.advanced", runId: context.runId,
      documentId: flushed.document.documentId, versionId: flushed.document.versionId,
      ...(flushed.versionNumber !== undefined ? { versionNumber: flushed.versionNumber } : {}),
      baseVersionId: flushed.baseVersionId, at: new Date().toISOString(),
    });
    return flushed;
  }
  return {
    begin() { priorFlush = undefined; },
    async beforeTool(context) {
      if (FORMATTER_TOOL_NAMES.has(context.toolName)) return;
      const flushed = await flush(context);
      if (flushed.status === "error") throw new Error(flushed.diagnostics[0].message);
    },
    async finalize(context) {
      const flushed = priorFlush ?? await flush(context);
      if (flushed.status === "noop") return context.toolOutcomes;
      if (flushed.status === "error") {
        return context.toolOutcomes.map((outcome) =>
          isPendingOutcome(outcome)
            ? { ...outcome, status: "failed" as const, summary: flushed.diagnostics[0].message, diagnostic: flushed.diagnostics[0], output: undefined }
            : outcome,
        );
      }
      return context.toolOutcomes.map((outcome) => {
        if (!isPendingOutcome(outcome)) return outcome;
        const pending = outcome.output as { operation: string; diagnostics: readonly Diagnostic[]; change?: unknown };
        return {
          ...outcome,
          output: {
            status: "success", document: flushed.document,
            ...(flushed.versionNumber !== undefined ? { versionNumber: flushed.versionNumber } : {}),
            baseVersionId: flushed.baseVersionId,
            ...(pending.change !== undefined ? { change: pending.change } : {}),
            diagnostics: pending.diagnostics,
          },
        };
      });
    },
    abandon() { pendingMutations.abandonPendingFormatting?.(); },
  };
}

const FORMATTER_TOOL_NAMES = new Set([
  "document.set_paragraph_style",
  "document.set_paragraph_formatting",
  "document.set_text_formatting",
]);

function isPendingOutcome(outcome: ToolBatchContext["toolOutcomes"][number]): boolean {
  return !!outcome.output && typeof outcome.output === "object" &&
    (outcome.output as { status?: unknown }).status === "pending";
}

export function createDocumentAgentRunnerPolicyOptions(state?: DocumentRunState) {
  return {
    transformContext: (messages: Parameters<TransformAgentContext>[0]) =>
      transformContext(messages, state?.working),
    shouldTerminalizeToolBatch: shouldTerminalizeDocumentToolBatch,
    getModelTimeoutRetryMessage: getDocumentModelTimeoutRetryMessage,
    requiredToolsNudgeMessage: USE_DOCUMENT_TOOLS_NUDGE_MESSAGE,
  };
}

function shouldTerminalizeDocumentToolBatch({
  content,
  toolCalls,
  toolOutcomes,
  tools,
}: ToolBatchContext): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 12) return false;
  if (toolCalls.length === 0 || toolOutcomes.length !== toolCalls.length) {
    return false;
  }
  if (toolOutcomes.some((outcome) => outcome.status !== "succeeded")) {
    return false;
  }
  if (toolOutcomes.some((outcome) => outcome.diagnostic?.severity === "error")) {
    return false;
  }

  return toolCalls.some((call) => {
    if (isDocumentWriteTool(call.name)) return true;
    if (call.name === CREATE_BLANK_TOOL) return false;
    const tool = tools.get(call.name);
    return tool !== undefined && toolEffect(tool) === "write";
  });
}

function getDocumentModelTimeoutRetryMessage({
  toolOutcomes,
}: ModelTimeoutContext): string | undefined {
  // One compact-first-pass retry when a write stall is likely:
  // - post-create authoring (create ok, no write yet), or
  // - open-doc first turn with no tools yet (e.g. "write a paper" building a
  //   giant insert_paragraphs payload and hanging until the 90s wall timeout).
  // Skip once any write landed, or after a successful read (Q&A answer stalls
  // are different — do not nudge create/author tools there).
  if (hasSuccessfulMutation(toolOutcomes)) return undefined;
  if (hasSuccessfulDocumentRead(toolOutcomes)) return undefined;
  if (hasSuccessfulCreate(toolOutcomes) || toolOutcomes.length === 0) {
    return AUTHORING_TIMEOUT_RETRY_MESSAGE;
  }
  return undefined;
}

function hasSuccessfulDocumentRead(outcomes: readonly ToolOutcome[]): boolean {
  return outcomes.some(
    (o) =>
      o.status === "succeeded" &&
      (o.toolName === "document.inspect" || o.toolName === "document.find"),
  );
}

function isDocumentWriteTool(name: string): boolean {
  if (!name.startsWith("document.")) return false;
  return (
    name !== "document.inspect" &&
    name !== "document.find" &&
    name !== "document.capabilities"
  );
}

function hasSuccessfulCreate(outcomes: readonly ToolOutcome[]): boolean {
  return outcomes.some(
    (o) => o.status === "succeeded" && o.toolName === CREATE_BLANK_TOOL,
  );
}

function hasSuccessfulMutation(outcomes: readonly ToolOutcome[]): boolean {
  return outcomes.some(
    (o) => o.status === "succeeded" && isDocumentWriteTool(o.toolName),
  );
}

function resolveToolChoice(
  tools: ToolRegistry,
  outcomes: readonly ToolOutcome[],
): "auto" | "required" | undefined {
  if (tools.definitions().length === 0) {
    return undefined;
  }
  const created = hasSuccessfulCreate(outcomes);
  const mutated = hasSuccessfulMutation(outcomes);
  // Post-create authoring: force tools until first document write. This is
  // safe to force — the user's intent to work on a document is already
  // established by the successful create call.
  if (created && !mutated) {
    return "required";
  }
  // Before any create/mutation (fresh greenfield turn, or open-doc Q&A), we
  // have no reliable signal that the user wants document work at all — the
  // message could be a plain greeting or question. Never force a tool call
  // here: forcing "required" with only `workspace.create_blank_docx`
  // available would make the model create an unwanted document for any
  // non-document message. The system prompt guides real create requests;
  // "auto" lets the model decide.
  return "auto";
}

function selectToolsForModel(
  tools: ToolRegistry,
  outcomes: readonly ToolOutcome[],
  state: DocumentRunState,
): readonly ModelToolDefinition[] {
  const defs = tools.definitions();
  const created = hasSuccessfulCreate(outcomes);
  const mutated = hasSuccessfulMutation(outcomes);
  // Narrow only the first post-create authoring turn (create done, no write yet).
  if (created && !mutated) {
    const narrowed = defs.filter((tool) =>
      POST_CREATE_AUTHORING_TOOL_NAMES.has(tool.name),
    );
    return narrowed.length > 0 ? narrowed : defs;
  }
  const families = new Set(DEFAULT_WORKING_FAMILIES);
  for (const outcome of outcomes) {
    const family = DOCUMENT_TOOL_FAMILIES[outcome.toolName];
    if (family) families.add(family);
    if (outcome.status === "failed") families.add("read");
  }
  if (workingStateShowsTables(state.working?.inspection)) families.add("tables");
  const narrowed = defs.filter((tool) => {
    const family = DOCUMENT_TOOL_FAMILIES[tool.name];
    return family === undefined || families.has(family);
  });
  return narrowed.length > 0 ? narrowed : defs;
}

function workingStateShowsTables(inspection: unknown): boolean {
  if (!inspection || typeof inspection !== "object") return false;
  const payload = (inspection as { payload?: unknown }).payload;
  return !!payload && typeof payload === "object" &&
    Array.isArray((payload as { tables?: unknown }).tables) &&
    (payload as { tables: unknown[] }).tables.length > 0;
}
