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

import type { AgentTool, ModelToolDefinition } from "../model.js";
import type { ToolOutcome } from "../request.js";
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

/** Blank-document creation tool name (workspace-owned, not a document tool). */
const CREATE_BLANK_TOOL = "workspace.create_blank_docx";

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
  const { baseTools, documentToolCatalog, runtime } = options;

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
      startedWithPrimary = context.primaryDocument != null;
    }

    const currentPrimaryId = context.primaryDocument?.documentId ?? null;
    if (
      bootstrappedPrimaryId === undefined ||
      currentPrimaryId !== bootstrappedPrimaryId
    ) {
      const result = await bootstrap(context.primaryDocument);
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

function isDocumentWriteTool(name: string): boolean {
  if (!name.startsWith("document.")) return false;
  return name !== "document.inspect" && name !== "document.find";
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
