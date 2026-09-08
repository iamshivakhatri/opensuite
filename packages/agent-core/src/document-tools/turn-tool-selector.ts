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
import type {
  ModelTimeoutContext,
  ToolBatchContext,
} from "../runner.js";
import type { DocumentRuntime } from "../runtime.js";
import { ToolRegistry } from "../tools.js";
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
  createDocumentRunState,
  createDocumentToolContext,
  type DocumentRunState,
} from "./run-state.js";

/** Blank-document creation tool name (workspace-owned, not a document tool). */
const CREATE_BLANK_TOOL = "workspace.create_blank_docx";

const AUTHORING_TIMEOUT_RETRY_MESSAGE =
  "Runtime policy: previous authoring model turn timed out. " +
  "Call tools now with a compact first pass only: document.insert_paragraphs " +
  "(title + short intro), document.set_paragraph_style Heading 1 on the title, " +
  "and one document.create_table with at most 6–8 rows. " +
  "Do not generate a giant single payload.";

const USE_DOCUMENT_TOOLS_NUDGE_MESSAGE =
  "Runtime policy: you must use tools for document work — do not put the document body in chat. " +
  "If the user wants a NEW document, call workspace.create_blank_docx alone first. " +
  "If editing the already-open document, use inspect / set_paragraph_style / mutation tools as needed — do not create another blank file. " +
  "Short confirmation text only after tools succeed.";

/**
 * After blank create, only advertise core authoring tools until the first
 * write lands. A full catalog + tool_choice=required can hang slow models
 * for minutes while they stall before the first token.
 */
const POST_CREATE_AUTHORING_TOOL_NAMES = new Set<string>([
  "document.insert_paragraph",
  "document.insert_paragraphs",
  "document.create_table",
  "document.set_table_cells_text",
  "document.set_paragraph_style",
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
  /** True when the run began with an open primary (Q&A/edit vs blank workspace). */
  let startedWithPrimary: boolean | null = null;

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
    if (startedWithPrimary === null) {
      startedWithPrimary = state.primary != null;
    }

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
      toolsForModel: selectToolsForModel(cachedRegistry, context.toolOutcomes),
      toolChoice: resolveToolChoice(
        cachedRegistry,
        context.toolOutcomes,
        startedWithPrimary,
      ),
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
  readonly shouldTerminalizeToolBatch: (context: ToolBatchContext) => boolean;
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
    ...createDocumentAgentRunnerPolicyOptions(),
  };
}

export function createDocumentAgentRunnerPolicyOptions() {
  return {
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
  return hasSuccessfulCreate(toolOutcomes) &&
    !hasSuccessfulMutation(toolOutcomes)
    ? AUTHORING_TIMEOUT_RETRY_MESSAGE
    : undefined;
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

function hasSuccessfulDocumentRead(outcomes: readonly ToolOutcome[]): boolean {
  return outcomes.some(
    (o) =>
      o.status === "succeeded" &&
      (o.toolName === "document.inspect" || o.toolName === "document.find"),
  );
}

function resolveToolChoice(
  tools: ToolRegistry,
  outcomes: readonly ToolOutcome[],
  startedWithPrimary: boolean,
): "auto" | "required" | undefined {
  if (tools.definitions().length === 0) {
    return undefined;
  }
  const hasCreate = tools.get(CREATE_BLANK_TOOL) !== undefined;
  const created = hasSuccessfulCreate(outcomes);
  const mutated = hasSuccessfulMutation(outcomes);
  // Post-create authoring: force tools until first document write.
  if (created && !mutated) {
    return "required";
  }
  // Open-doc Q&A/edit: after inspect/find, allow a normal text answer.
  // Do not keep forcing create — that falsely fails "what does paragraph 2 say?".
  if (startedWithPrimary && hasSuccessfulDocumentRead(outcomes) && !created) {
    return "auto";
  }
  // Greenfield: force tools until create or any write.
  if (hasCreate && !created && !mutated) {
    return "required";
  }
  return "auto";
}

function selectToolsForModel(
  tools: ToolRegistry,
  outcomes: readonly ToolOutcome[],
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
  return defs;
}
