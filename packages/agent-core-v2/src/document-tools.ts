import { jsonSchema, tool, type ToolSet } from "ai";

/**
 * Bound document host for Phase 2B.
 * API binds exact version bytes + engine (+ persist); V2 never sees IDs/storage.
 */
export interface BoundDocumentHost {
  capabilities(): unknown;
  inspect(request: { readonly focus: InspectFocus }): Promise<unknown>;
  find(request: { readonly text: string }): Promise<unknown>;
  /** Present when writes are wired. */
  mutate?(
    capability: string,
    operation: Record<string, unknown>,
  ): Promise<unknown>;
}

/** @deprecated Prefer BoundDocumentHost — kept for existing call sites/tests. */
export type BoundDocumentReads = BoundDocumentHost;

export type InspectFocus =
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

const emptyInput = jsonSchema<{ _?: never }>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const findInput = jsonSchema<{ text: string }>({
  type: "object",
  properties: {
    text: { type: "string", description: "Exact text to find" },
  },
  required: ["text"],
  additionalProperties: false,
});

type InspectToolInput = {
  kind: InspectFocus["kind"];
  offset?: number;
  limit?: number;
  text?: string;
  occurrence?: number;
  before?: number;
  after?: number;
};

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
    occurrence: { type: "number" },
    before: { type: "number" },
    after: { type: "number" },
  },
  required: ["kind"],
  additionalProperties: false,
});

/** Compact op schema: required fields + pass-through for engine optionals. */
function op(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) {
  return jsonSchema<Record<string, unknown>>({
    type: "object",
    properties,
    required: [...required],
    additionalProperties: true,
  });
}

const textTarget = {
  type: "object",
  properties: { text: { type: "string" }, occurrence: { type: "number" } },
  required: ["text"],
  additionalProperties: true,
};
const placement = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["start", "end", "before", "after"] },
    handle: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: true,
};
const tableTarget = {
  type: "object",
  properties: {
    headerCells: { type: "array", items: { type: "string" } },
    occurrence: { type: "number" },
    handle: { type: "string" },
  },
  additionalProperties: true,
};
const strings = { type: "array", items: { type: "string" } };
const stringRows = { type: "array", items: strings };
const loose = op({});

type MutDef = { readonly description: string; readonly inputSchema: ReturnType<typeof op> };

/** Capability id → typed tool. Gated by engine caps + host.mutate. */
const MUTATION_DEFS: Record<string, MutDef> = {
  replace_text: {
    description: "Replace exact text. Supply expectedCurrentText from inspect/find.",
    inputSchema: op(
      { target: textTarget, expectedCurrentText: { type: "string" }, replacement: { type: "string" } },
      ["target", "expectedCurrentText", "replacement"],
    ),
  },
  insert_paragraph: {
    description: "Insert one paragraph (placement: start/end/before/after).",
    inputSchema: op({ text: { type: "string" }, placement }, ["text", "placement"]),
  },
  insert_paragraphs: {
    description: "Insert multiple paragraphs at a placement.",
    inputSchema: op({ texts: strings, placement }, ["texts", "placement"]),
  },
  delete_paragraph: {
    description: "Delete a paragraph by text target.",
    inputSchema: op({ target: textTarget }, ["target"]),
  },
  set_paragraph_style: {
    description: "Set or clear paragraph style.",
    inputSchema: op({ target: textTarget, style: { type: "string" } }, ["target"]),
  },
  set_paragraph_formatting: {
    description: "Set paragraph alignment/spacing/indent.",
    inputSchema: op({ target: textTarget }, ["target"]),
  },
  set_text_formatting: {
    description: "Set run formatting (bold/italic/size/color/…).",
    inputSchema: op({ target: textTarget }, ["target"]),
  },
  set_table_cells_text: {
    description: "Atomically update table cells. Prefer handles from inspect(tables).",
    inputSchema: op({ table: tableTarget, updates: { type: "array", items: { type: "object" } } }, ["table", "updates"]),
  },
  insert_table_rows: {
    description: "Insert rows after a table row anchor.",
    inputSchema: op({ table: tableTarget, after: { type: "object" }, rows: stringRows }, ["table", "after", "rows"]),
  },
  insert_table_row: {
    description: "Insert a single table row.",
    inputSchema: op({ table: tableTarget }, ["table"]),
  },
  insert_table_column: {
    description: "Insert a table column (header + cells).",
    inputSchema: op({ table: tableTarget, header: { type: "string" }, cells: strings }, ["table", "header", "cells"]),
  },
  create_table: {
    description: "Create a table at a paragraph placement.",
    inputSchema: op({ rows: stringRows, placement }, ["rows", "placement"]),
  },
  delete_table: { description: "Delete a table.", inputSchema: op({ table: tableTarget }, ["table"]) },
  delete_table_row: {
    description: "Delete a table row.",
    inputSchema: op({ table: tableTarget, row: { type: "object" } }, ["table", "row"]),
  },
  delete_table_column: {
    description: "Delete a table column.",
    inputSchema: op({ table: tableTarget }, ["table"]),
  },
  set_table_formatting: {
    description: "Set table alignment/margins/borders.",
    inputSchema: op({ table: tableTarget }, ["table"]),
  },
  set_table_column_widths: {
    description: "Set table column widths in twips.",
    inputSchema: op({ table: tableTarget, widthsTwips: { type: "array", items: { type: "number" } } }, ["table", "widthsTwips"]),
  },
  set_table_cell_shading: {
    description: "Set table cell fill/shading.",
    inputSchema: op({ table: tableTarget, updates: { type: "array", items: { type: "object" } } }, ["table", "updates"]),
  },
};

for (const [capability, description] of [
  ["set_content_control_text", "Set content-control text."],
  ["set_paragraphs_list", "Apply list formatting to paragraphs."],
  ["set_hyperlink", "Add or update a hyperlink."],
  ["insert_picture", "Insert a picture."],
  ["delete_picture", "Delete a picture."],
  ["set_picture_size", "Resize a picture."],
  ["replace_picture", "Replace a picture."],
  ["insert_page_break", "Insert a page break."],
  ["delete_page_break", "Delete a page break."],
  ["set_page_setup", "Update page setup."],
  ["set_header_footer_text", "Set header/footer text."],
  ["set_page_number", "Set page number fields."],
] as const) {
  MUTATION_DEFS[capability] = { description, inputSchema: loose };
}

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

/** AI SDK tools for the Phase-1 loop. Names match product progress labels. */
export function createDocumentTools(document: BoundDocumentHost): ToolSet {
  const caps = docxCapabilitySet(document.capabilities());
  const tools: ToolSet = {
    "document.capabilities": tool({
      description: "List real DOCX engine capabilities for the bound document.",
      inputSchema: emptyInput,
      execute: async () => document.capabilities(),
    }),
  };

  if (caps.has(READ_CAPS.inspect)) {
    tools["document.inspect"] = tool({
      description:
        "Inspect the bound DOCX (overview, headings, paragraphs, tables, body_blocks, or context).",
      inputSchema: inspectInput,
      execute: async (input) =>
        document.inspect({ focus: toInspectFocus(input) }),
    });
  }

  if (caps.has(READ_CAPS.find)) {
    tools["document.find"] = tool({
      description: "Find exact text occurrences in the bound DOCX.",
      inputSchema: findInput,
      execute: async ({ text }) => document.find({ text }),
    });
  }

  if (document.mutate) {
    const mutate = document.mutate.bind(document);
    for (const [capability, def] of Object.entries(MUTATION_DEFS)) {
      if (!caps.has(capability)) continue;
      const toolName = `document.${capability}`;
      tools[toolName] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (input) =>
          mutate(capability, (input ?? {}) as Record<string, unknown>),
      });
    }
  }

  return tools;
}

/** Document write tools (excludes capabilities/inspect/find). */
export function isDocumentWriteTool(toolName: string): boolean {
  return (
    toolName.startsWith("document.") &&
    toolName !== "document.capabilities" &&
    toolName !== "document.inspect" &&
    toolName !== "document.find"
  );
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
