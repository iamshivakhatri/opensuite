import { createHash } from "node:crypto";

import { DOCX_MUTATION_CAPABILITIES, docxOperationDefinitions, docxAgentInputSchema } from "@opensuite/engine-client";
import { jsonSchema } from "ai";
import {
  defineTool,
  type AgentToolSet,
} from "@opensuite/agent-core";

/**
 * Bound document host for agent runs.
 * API binds exact version bytes + engine (+ persist); tools never see IDs/storage.
 */
export interface BoundDocumentHost {
  capabilities(): unknown;
  documentId?(): string | null;
  inspect(request: { readonly focus: InspectFocus }): Promise<unknown>;
  renderLayout?(): Promise<unknown>;
  find(request: { readonly text: string }): Promise<unknown>;
  /** Present when writes are wired. */
  mutate?(
    capability: string,
    operation: Record<string, unknown>,
  ): Promise<unknown>;
  mutateBatch?(
    capability: string,
    operations: readonly Record<string, unknown>[],
  ): Promise<unknown>;
}

export type InspectFocus =
  | { readonly kind: "notes"; readonly offset?: number; readonly limit?: number }
  | { readonly kind: "fields"; readonly offset?: number; readonly limit?: number }
  | { readonly kind: "revisions"; readonly offset?: number; readonly limit?: number }
  | { readonly kind: "comments"; readonly offset?: number; readonly limit?: number }
  | { readonly kind: "layout"; readonly blockOffset?: number; readonly blockLimit?: number; readonly sectionIndex?: number }
  | { readonly kind: "sections" }
  | { readonly kind: "overview" }
  | {
      readonly kind: "headings" | "paragraphs" | "tables" | "body_blocks";
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "context";
      readonly text: string;
      readonly occurrence?: number;
      readonly before?: number;
      readonly after?: number;
    };

const findInput = jsonSchema<{ text: string }>({
  type: "object",
  properties: {
    text: { type: "string", description: "Exact text to find" },
  },
  required: ["text"],
  additionalProperties: false,
});

type InspectToolInput = {
  kind: Exclude<InspectFocus["kind"], "sections" | "layout" | "comments" | "revisions" | "fields" | "notes">;
  offset?: number;
  limit?: number;
  text?: string;
  occurrence?: number;
  before?: number;
  after?: number;
};

const occurrenceField = {
  type: "number",
  description:
    "Zero-based occurrence among matching targets. Same convention as find.matches[].occurrence and inspect paragraphs.targetOccurrence / tables.occurrence. Omit when the match is unique.",
} as const;

const inspectInput = jsonSchema<InspectToolInput>({
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "overview",
        "headings",
        "paragraphs",
        "tables",
        "body_blocks",
        "context",
      ],
    },
    offset: { type: "number" },
    limit: { type: "number" },
    text: { type: "string" },
    occurrence: occurrenceField,
    before: { type: "number" },
    after: { type: "number" },
  },
  required: ["kind"],
  additionalProperties: false,
});

function op(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) {
  return jsonSchema<Record<string, unknown>>({
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  });
}

const BATCH_TOOLS = {
  replace_text: "batch_replace_text",
  set_paragraph_style: "batch_paragraph_styles",
  set_paragraph_formatting: "batch_paragraph_formatting",
  set_text_formatting: "batch_text_formatting",
} as const;

/** Binary-only operations remain behind owned workspace asset tools. */
export const HIDDEN_BINARY_MUTATION_CAPABILITIES = Object.freeze(["insert_picture", "replace_picture"] as const);
/** Compatibility list; actual tools come from the selected engine's inputs. */
export const MODEL_MUTATION_CAPABILITIES = Object.freeze(
  DOCX_MUTATION_CAPABILITIES.filter(id => !HIDDEN_BINARY_MUTATION_CAPABILITIES.includes(id as "insert_picture" | "replace_picture")),
);

const engineDocumentTools = new WeakSet<object>();
export const isEngineDocumentTool = (tool: object) => engineDocumentTools.has(tool);

const READ_CAPS = {
  inspect: "inspect",
  find: "find_text",
} as const;

function docxCapabilitySet(capabilities: unknown): Set<string> {
  const set = new Set<string>();
  if (!capabilities || typeof capabilities !== "object") return set;
  const formats = (capabilities as { formats?: unknown }).formats;
  if (!Array.isArray(formats)) return set;
  for (const format of formats) {
    if (!format || typeof format !== "object") continue;
    const f = format as { format?: unknown; capabilities?: unknown };
    if (f.format !== "docx" || !Array.isArray(f.capabilities)) continue;
    for (const cap of f.capabilities) {
      if (typeof cap === "string") set.add(cap);
    }
  }
  return set;
}

/** agent-core AgentTools for the live loop. Names match product progress labels. */
export function createDocumentTools(document: BoundDocumentHost): AgentToolSet {
  const capabilities = document.capabilities();
  const caps = docxCapabilitySet(capabilities);
  const definitions = new Map(docxOperationDefinitions(capabilities)
    .filter(op => op.kind === "mutate" && op.jsonInput)
    .map(op => [op.id, { description: op.description, inputSchema: jsonSchema<Record<string, unknown>>(docxAgentInputSchema(op)) }]));
  const tools: AgentToolSet = {};
  const effectKeys = (input: unknown, output: unknown) =>
    mutationEffectKeys(input, output, document.documentId?.() ?? undefined);

  if (caps.has(READ_CAPS.inspect)) {
    tools["document.inspect"] = defineTool({
      kind: "read",
      description:
        "Return structural or contextual document state for a chosen focus (overview, headings, paragraphs, tables, body_blocks, or context around a text match). Occurrence values are zero-based.",
      inputSchema: inspectInput,
      execute: async (input) =>
        document.inspect({ focus: toInspectFocus(input) }),
    });
  }

  if (caps.has("layout_snapshot")) {
    tools["document.inspect_layout"] = defineTool({ kind: "read",
      description: "Inspect structural section geometry, explicit pagination controls, table/image dimensions, floating-image positions/wrap, fresh image handles, and width warnings. No automatic page positions. Default returns summaries; blockLimit (0–100) and blockOffset request details; sectionIndex selects a zero-based section.",
      inputSchema: op({ blockOffset: { type: "integer", minimum: 0 }, blockLimit: { type: "integer", minimum: 0, maximum: 100 }, sectionIndex: { type: "integer", minimum: 0 } }),
      execute: async input => document.inspect({ focus: { kind: "layout", ...input } }),
    });
    if (document.renderLayout) tools["document.render_layout"] = defineTool({ kind: "read",
      description: "Get LibreOffice-derived PDF page count and page dimensions using the optional external renderer. Depends on installed fonts and tools; failures report unavailable, never estimated. Exact block-to-page mapping is unavailable. Does not save a document version.",
      inputSchema: op({}), execute: () => document.renderLayout!(),
    });
  }
  if (caps.has("inspect_fields")) {
    tools["document.inspect_fields"] = defineTool({ kind: "read",
      description: "Inspect Word fields including TOC, PAGE, NUMPAGES, DATE, and unknown instructions. Returns bounded instruction and cached text separately, representation, part/paragraph location, dirty/locked flags when present, common TOC heading levels, and structural diagnostics. Main document and header/footer parts. Default 20, maximum 100 records; text capped at 2000 characters. Dirty means refresh requested; absent flags do not prove results are current. Does not calculate or edit fields.",
      inputSchema: op({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      execute: async input => document.inspect({ focus: { kind: "fields", ...input } }),
    });
  }
  if (caps.has("inspect_tracked_changes")) {
    tools["document.inspect_tracked_changes"] = defineTool({ kind: "read",
      description: "Inspect existing Word tracked insertions/deletions: IDs, author/date, bounded text, source-order paragraph locations, totals, and complex-revision diagnostics. Main document including tables only. Default 20, maximum 100 per page; text/metadata capped at 2000 characters. Current document text includes insertions and excludes deletions. Does not edit or save a version.",
      inputSchema: op({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      execute: async input => document.inspect({ focus: { kind: "revisions", ...input } }),
    });
  }
  if (caps.has("inspect_notes")) {
    tools["document.inspect_notes"] = defineTool({ kind: "read",
      description: "Inspect ordinary footnotes and endnotes, fresh handles, note IDs, text, zero-based body paragraph and source reference indexes, reference counts, structural status, and imported numbering settings. Separators are excluded and protected. IDs differ from visible note numbers. Default 20, maximum 100 records per page; note text capped at 2000 characters. Read-only.",
      inputSchema: op({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      execute: async input => document.inspect({ focus: { kind: "notes", ...input } }),
    });
  }
  if (caps.has("inspect_comments")) {
    tools["document.inspect_comments"] = defineTool({ kind: "read",
      description: "Inspect standard comments, author/date, bounded text, attached text, source-order paragraph locations, fresh handles, and malformed/orphan diagnostics. Default 20; maximum 100 per page. Re-inspect after editing. Resolved state and replies are unavailable.",
      inputSchema: op({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      execute: async input => document.inspect({ focus: { kind: "comments", ...input } }),
    });
  }
  if (caps.has("inspect_sections")) {
    tools["document.inspect_sections"] = defineTool({
      kind: "read",
      description: "Inspect ordered Word sections with fresh handles, page setup, numbering, and owned/inherited header/footer variants. Re-inspect after every section edit.",
      inputSchema: op({}),
      execute: async () => document.inspect({ focus: { kind: "sections" } }),
    });
  }

  if (caps.has(READ_CAPS.find)) {
    tools["document.find"] = defineTool({
      kind: "read",
      description:
        "Return exact-text match locations with zero-based occurrence indexes for targeting subsequent operations.",
      inputSchema: findInput,
      execute: async ({ text }) => document.find({ text }),
    });
  }

  if (document.mutate) {
    const mutate = document.mutate.bind(document);
    for (const [capability, def] of definitions) {
      if (!caps.has(capability)) continue;
      const toolName = `document.${capability}`;
      tools[toolName] = defineTool({
        kind: "mutate",
        description: def.description,
        inputSchema: def.inputSchema,
        effectKeys,
        execute: async (input) =>
          mutate(capability, (input ?? {}) as Record<string, unknown>),
      });
      engineDocumentTools.add(tools[toolName]!);
    }
  }

  if (document.mutateBatch) {
    const mutateBatch = document.mutateBatch.bind(document);
    for (const [capability, name] of Object.entries(BATCH_TOOLS)) {
      if (!caps.has(capability) || !definitions.has(capability)) continue;
      tools[`document.${name}`] = defineTool({
        kind: "mutate",
        description: `Apply several independent ${capability} operations in order. Stops on the first failure; earlier successful edits remain. Use known text targets only.${
          capability === "set_text_formatting"
            ? " Supports body text, partial spans, and simple table-cell runs; use set_table_cells_formatting for known whole cells."
            : capability !== "replace_text"
              ? " Formatting targets direct body text, not table cells."
              : ""
        }`,
        inputSchema: jsonSchema<{ operations: Record<string, unknown>[] }>({
          type: "object",
          properties: {
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: definitions.get(capability)!.inputSchema.jsonSchema,
            },
          },
          required: ["operations"],
          additionalProperties: false,
        }),
        effectKeys,
        execute: async ({ operations }) => mutateBatch(capability, operations),
      });
    }
  }

  return tools;
}

const TARGET_FIELDS = new Set(["table", "target", "targets", "row", "after", "placement", "columnHeader", "styleId"]);

/**
 * One `target|effect` key per unit of attempted work: each batch operation from
 * the first failed one, each table update, or the whole call. Preserve exact
 * selectors and values: changed handles cannot prove the same object was edited.
 */
export function mutationEffectKeys(input: unknown, output: unknown, documentId?: string): string[] {
  const record = isRecord(input) ? input : {};
  let units: Record<string, unknown>[] = [record];
  if (Array.isArray(record.operations)) {
    const failedIndex = isRecord(output) && output.ok === false && typeof output.failedIndex === "number" ? output.failedIndex : 0;
    units = record.operations.slice(failedIndex).filter(isRecord);
  } else if (Array.isArray(record.updates)) {
    const { updates, ...shared } = record;
    units = updates.filter(isRecord).map((update) => ({ ...shared, ...update }));
  }
  return units.map((unit) => {
    const target: Record<string, unknown> = documentId ? { documentId } : {};
    const effect: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(unit)) {
      if (key === "expectedCurrentText" || key === "baseRevision") continue;
      (TARGET_FIELDS.has(key) ? target : effect)[key] = value;
    }
    return `${identityHash(target)}|${identityHash(effect)}`;
  });
}

function identityHash(value: Record<string, unknown>): string {
  const canonical = canonicalIdentity(value);
  return canonical === "{}" ? "" : createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function canonicalIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIdentity).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalIdentity(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toInspectFocus(input: InspectToolInput): InspectFocus {
  switch (input.kind) {
    case "overview":
      return { kind: "overview" };
    case "headings":
    case "paragraphs":
    case "tables":
    case "body_blocks":
      return {
        kind: input.kind,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      };
    case "context":
      if (!input.text) {
        throw new Error("document.inspect context focus requires text");
      }
      return {
        kind: "context",
        text: input.text,
        ...(input.occurrence !== undefined
          ? { occurrence: input.occurrence }
          : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
      };
    default: {
      const _exhaustive: never = input.kind;
      throw new Error(`Unsupported inspect focus: ${String(_exhaustive)}`);
    }
  }
}
