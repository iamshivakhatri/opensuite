/**
 * Explicit boundary: canonical runtime transcript → model-facing messages.
 *
 * V1 is deterministic and local — no summarization, vector memory, or LLM compaction.
 * Provider adapters must not own this policy.
 */

import {
  isPersistedDocumentMutationToolResult,
  type PersistedDocumentMutationToolResult,
} from "./document-mutation.js";
import type { ModelMessage } from "./model.js";
import {
  shapeDiagnosticForToolResult,
  type Diagnostic,
  type RuntimeCapabilities,
} from "./types.js";

/**
 * Project the canonical in-memory transcript into messages safe to send to a provider.
 * Preserves tool-call / tool-result pairing and IDs; slims successful mutation payloads.
 */
export function transformContext(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }
    const projected = projectToolResultForModel(message);
    return {
      role: "tool" as const,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      ...(projected.summary !== undefined
        ? { summary: projected.summary }
        : {}),
      ...(projected.output !== undefined ? { output: projected.output } : {}),
      ...(projected.diagnostic !== undefined
        ? { diagnostic: projected.diagnostic }
        : {}),
    };
  });
}

export interface ModelFacingToolProjection {
  readonly summary?: string;
  readonly output?: unknown;
  readonly diagnostic?: Diagnostic;
}

/**
 * Deterministic model-facing projection of one tool transcript message.
 * Persistence / SSE / UI may retain the richer canonical output separately.
 */
export function projectToolResultForModel(
  message: Extract<ModelMessage, { role: "tool" }>,
): ModelFacingToolProjection {
  if (message.status === "failed" || message.status === "skipped") {
    if (message.diagnostic) {
      return {
        summary: message.summary,
        output: {
          ok: false,
          ...shapeDiagnosticForToolResult(message.diagnostic),
        },
        diagnostic: message.diagnostic,
      };
    }
    return {
      summary: message.summary,
      output: {
        ok: false,
        status: message.status,
        ...(message.summary !== undefined ? { message: message.summary } : {}),
      },
    };
  }

  const output = message.output;
  if (isPersistedDocumentMutationToolResult(output)) {
    const slim = projectSuccessfulMutationForModel(message.toolName, output);
    return {
      summary: slimSummary(slim),
      output: slim,
    };
  }

  if (message.toolName === "workspace.create_blank_docx") {
    const slim = projectCreateBlankForModel(output);
    return {
      summary: slimSummary(slim),
      output: slim,
    };
  }

  // Inspect/find: JSON-safe + drop Set-shaped capabilities (they serialize as {}
  // and falsely look like "no capabilities"). Tool list already gates ops.
  const safe = projectReadToolOutputForModel(output);
  return {
    summary:
      typeof message.summary === "string" && !message.summary.includes('"ids":{}')
        ? message.summary
        : slimSummary(safe as Record<string, unknown>),
    ...(safe !== undefined ? { output: safe } : {}),
  };
}

function projectCreateBlankForModel(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object") {
    return { ok: true, operation: "workspace.create_blank_docx" };
  }
  const record = output as Record<string, unknown>;
  const document = record.document;
  return {
    ok: true,
    operation: "workspace.create_blank_docx",
    ...(document && typeof document === "object"
      ? { document: jsonSafe(document) }
      : {}),
  };
}

function projectReadToolOutputForModel(output: unknown): unknown {
  if (!output || typeof output !== "object") {
    return output;
  }
  const record = { ...(output as Record<string, unknown>) };
  // Never send Set-backed RuntimeCapabilities to the model — JSON becomes {"ids":{}}.
  if ("capabilities" in record) {
    const caps = record.capabilities;
    if (isRuntimeCapabilities(caps)) {
      // Omit entirely: filtered tool catalog is authoritative.
      delete record.capabilities;
    } else if (caps && typeof caps === "object" && "ids" in caps) {
      const ids = (caps as { ids: unknown }).ids;
      if (ids instanceof Set) {
        delete record.capabilities;
      } else if (
        ids &&
        typeof ids === "object" &&
        !Array.isArray(ids) &&
        Object.keys(ids as object).length === 0
      ) {
        // Already-broken {"ids":{}} from a prior stringify — drop it.
        delete record.capabilities;
      } else if (Array.isArray(ids)) {
        record.capabilities = ids;
      } else {
        delete record.capabilities;
      }
    } else {
      delete record.capabilities;
    }
  }
  return jsonSafe(record);
}

function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  return (
    !!value &&
    typeof value === "object" &&
    "ids" in value &&
    (value as RuntimeCapabilities).ids instanceof Set
  );
}

function projectSuccessfulMutationForModel(
  toolName: string,
  result: PersistedDocumentMutationToolResult,
): Record<string, unknown> {
  const operation = result.change?.operation ?? toolName;
  const slim: Record<string, unknown> = {
    ok: true,
    operation,
    ...(result.versionNumber !== undefined
      ? { versionNumber: result.versionNumber }
      : {}),
    changed: changedLabelForOperation(operation, toolName),
    document: {
      documentId: result.document.documentId,
      versionId: result.document.versionId,
      format: result.document.format,
    },
    baseVersionId: result.baseVersionId,
  };

  const count = countHintFromChangeArea(result.change?.area);
  if (count !== undefined) {
    slim.count = count;
  }

  return slim;
}

function changedLabelForOperation(operation: string, toolName: string): string {
  const key = operation.includes(".") ? operation : toolName;
  switch (key) {
    case "document.insert_paragraph":
      return "paragraph_inserted";
    case "document.insert_paragraphs":
      return "paragraphs_inserted";
    case "document.delete_paragraph":
      return "paragraph_deleted";
    case "document.create_table":
      return "table_created";
    case "document.set_table_cells_text":
      return "table_cells_updated";
    case "document.insert_table_rows":
      return "table_rows_inserted";
    case "document.insert_table_column":
      return "table_column_inserted";
    case "document.delete_table":
      return "table_deleted";
    case "document.delete_table_row":
      return "table_row_deleted";
    case "document.delete_table_column":
      return "table_column_deleted";
    case "document.set_table_formatting":
      return "table_formatting_updated";
    case "document.replace_text":
      return "text_replaced";
    case "document.set_paragraph_style":
      return "paragraph_style_updated";
    case "document.set_paragraph_formatting":
      return "paragraph_formatting_updated";
    case "document.set_text_formatting":
      return "text_formatting_updated";
    default:
      return "document_mutated";
  }
}

/** Pull a useful count from engine/mock area labels like "5 paragraph(s)". */
function countHintFromChangeArea(area: string | undefined): number | undefined {
  if (!area) return undefined;
  const match = /(\d+)\s+(?:paragraph|row|cell|heading)/i.exec(area);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function slimSummary(slim: Record<string, unknown>): string {
  try {
    return JSON.stringify(slim);
  } catch {
    return "ok";
  }
}

/** JSON-clone with Set → sorted array so providers never see {"ids":{}}. */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nested) => {
        if (nested instanceof Set) {
          return [...nested].map(String).sort();
        }
        return nested;
      }),
    );
  } catch {
    return value;
  }
}
