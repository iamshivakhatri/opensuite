import { createHash } from "node:crypto";

import { DOCX_MUTATION_CAPABILITIES, docxOperationDefinitions, docxAgentInputSchema, docxOperationInputError, type DocxOperationDefinition } from "@opensuite/engine-client";
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
  readOperation?(capability: string, request: Record<string, unknown>): Promise<unknown>;
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
  | { readonly kind: "table_rows"; readonly tableHandle: string; readonly rowOffset?: number; readonly rowLimit?: number }
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

type InspectToolInput = {
  kind: Exclude<InspectFocus["kind"], "sections" | "layout" | "comments" | "revisions" | "fields" | "notes">;
  offset?: number;
  limit?: number;
  tableHandle?: string;
  text?: string;
  occurrence?: number;
  before?: number;
  after?: number;
};

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
  const operations = docxOperationDefinitions(capabilities);
  const definitions = new Map(operations
    .filter(op => op.kind === "mutate" && op.jsonInput)
    .map(op => [op.id, { description: op.description, inputSchema: jsonSchema<Record<string, unknown>>(docxAgentInputSchema(op)) }]));
  const tools: AgentToolSet = {};
  const effectKeys = (input: unknown, output: unknown) =>
    mutationEffectKeys(input, output, document.documentId?.() ?? undefined);
  const checkReadInput = (definition: DocxOperationDefinition, input: Record<string, unknown>) => {
    const error = docxOperationInputError(definition, input);
    if (error) throw new Error(`${definition.id}: ${error}`);
  };

  const inspect = operations.find(op => op.id === "inspect" && op.kind === "read");
  if (inspect) {
    // Keep the familiar flat focus input while deriving every field from Rust.
    const schema = (inspect.inputSchema.properties as Record<string, Record<string, unknown>>).focus;
    if (!schema) throw new Error("Engine inspect operation is missing its focus input definition");
    const flatInspect = { ...inspect, inputSchema: schema };
    tools["document.inspect"] = defineTool<InspectToolInput, unknown>({
      kind: "read", description: inspect.description,
      inputSchema: jsonSchema(schema),
      execute: input => { checkReadInput(flatInspect, input); return document.inspect({ focus: toInspectFocus(input) }); },
    });
  }
  const find = operations.find(op => op.id === "find_text" && op.kind === "read");
  if (find) tools["document.find"] = defineTool<{ text: string }, unknown>({
    kind: "read", description: find.description,
    inputSchema: jsonSchema(find.inputSchema), execute: input => { checkReadInput(find, input); return document.find(input); },
  });
  const readFocus = {
    layout_snapshot: { name: "inspect_layout", kind: "layout" },
    inspect_fields: { name: "inspect_fields", kind: "fields" },
    inspect_tracked_changes: { name: "inspect_tracked_changes", kind: "revisions" },
    inspect_notes: { name: "inspect_notes", kind: "notes" },
    inspect_comments: { name: "inspect_comments", kind: "comments" },
    inspect_sections: { name: "inspect_sections", kind: "sections" },
  } as const;
  for (const definition of operations.filter(op => op.kind === "read" && op.jsonInput)) {
    // These capabilities share document.inspect rather than adding duplicate tools.
    if (["inspect", "find_text", "body_blocks", "inspect_context"].includes(definition.id)) continue;
    const focus = readFocus[definition.id as keyof typeof readFocus];
    if (!focus && !document.readOperation) continue;
    const tool = defineTool<Record<string, unknown>, unknown>({
      kind: "read", description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
      execute: input => {
        checkReadInput(definition, input);
        return focus ? document.inspect({ focus: { kind: focus.kind, ...input } })
          : document.readOperation!(definition.id, input);
      },
    });
    engineDocumentTools.add(tool);
    tools[`document.${focus?.name ?? definition.id}`] = tool;
  }
  if (caps.has("layout_snapshot") && document.renderLayout) {
    tools["document.render_layout"] = defineTool({ kind: "read",
      description: "Get LibreOffice-derived PDF page count and page dimensions using the optional external renderer. Depends on installed fonts and tools; failures report unavailable, never estimated. Exact block-to-page mapping is unavailable. Does not save a document version.",
      inputSchema: op({}), execute: () => document.renderLayout!(),
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
    case "table_rows":
      if (!input.tableHandle) throw new Error("document.inspect table_rows requires tableHandle");
      return { kind: "table_rows", tableHandle: input.tableHandle, rowOffset: input.offset, rowLimit: input.limit };
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
