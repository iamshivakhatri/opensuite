import { jsonSchema } from "ai";
import {
  defineTool,
  type AgentToolSet,
} from "@opensuite/agent-core-v3";

/**
 * Bound document host for agent runs.
 * API binds exact version bytes + engine (+ persist); tools never see IDs/storage.
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

const textTarget = {
  type: "object",
  properties: {
    text: { type: "string", description: "Exact text to match" },
    occurrence: occurrenceField,
  },
  required: ["text"],
  additionalProperties: false,
};

const placement = {
  type: "object",
  description:
    "Paragraph placement. before/after require a body_blocks handle from inspect.",
  properties: {
    kind: { type: "string", enum: ["start", "end", "before", "after"] },
    handle: {
      type: "string",
      description: "Required when kind is before or after",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const tableTarget = {
  type: "object",
  description:
    "Table selector. Prefer handle from inspect(tables). occurrence is zero-based.",
  properties: {
    handle: { type: "string" },
    headerCells: { type: "array", items: { type: "string" } },
    occurrence: occurrenceField,
  },
  additionalProperties: false,
};

const rowAnchor = {
  type: "object",
  description: "Row selector. Prefer handle from inspect(tables).rows[].handle.",
  properties: {
    handle: { type: "string" },
    firstCellText: { type: "string" },
    occurrence: occurrenceField,
  },
  additionalProperties: false,
};

const cellTarget = {
  type: "object",
  description:
    "Cell selector: opaque handle from inspect, OR rowLabel+columnHeader.",
  properties: {
    handle: { type: "string" },
    rowLabel: { type: "string" },
    columnHeader: { type: "string" },
    occurrence: occurrenceField,
  },
  additionalProperties: false,
};

const strings = { type: "array", items: { type: "string" } };
const stringRows = { type: "array", items: strings };

type MutDef = {
  readonly description: string;
  readonly inputSchema: ReturnType<typeof op>;
};

/**
 * Model-facing mutation contracts. A capability is exposed only when:
 * engine advertises it AND it appears here AND host.mutate is bound.
 * Binary picture insert/replace are intentionally omitted (JSON cannot carry Buffer).
 * create_blank_docx is not a bound-document mutation.
 */
const MUTATION_DEFS: Record<string, MutDef> = {
  replace_text: {
    description:
      "Replace exact text. Supply expectedCurrentText from inspect/find. occurrence is zero-based.",
    inputSchema: op(
      {
        target: textTarget,
        expectedCurrentText: { type: "string" },
        replacement: { type: "string" },
      },
      ["target", "expectedCurrentText", "replacement"],
    ),
  },
  insert_paragraph: {
    description: "Insert one paragraph (placement: start/end/before/after).",
    inputSchema: op({ text: { type: "string" }, placement }, [
      "text",
      "placement",
    ]),
  },
  insert_paragraphs: {
    description: "Insert multiple paragraphs at a placement.",
    inputSchema: op({ texts: strings, placement }, ["texts", "placement"]),
  },
  delete_paragraph: {
    description: "Delete a paragraph by text target (occurrence zero-based).",
    inputSchema: op({ target: textTarget }, ["target"]),
  },
  set_paragraph_style: {
    description:
      "Set or clear paragraph style. style is the display name (e.g. 'Heading 1'), not styleId. Omit style to clear. Target via exact text + zero-based occurrence (use inspect paragraphs.targetOccurrence).",
    inputSchema: op(
      {
        target: textTarget,
        style: {
          type: "string",
          description: "Style display name such as 'Heading 1'. Omit to clear.",
        },
      },
      ["target"],
    ),
  },
  set_paragraph_formatting: {
    description: "Set paragraph alignment/spacing/indent on a text target.",
    inputSchema: op(
      {
        target: textTarget,
        alignment: {
          type: "string",
          enum: ["left", "center", "right", "clear"],
        },
        spacingBeforeTwips: { type: "number" },
        spacingAfterTwips: { type: "number" },
        leftIndentTwips: { type: "number" },
        clearLeftIndent: { type: "boolean" },
      },
      ["target"],
    ),
  },
  set_text_formatting: {
    description:
      "Set run formatting (bold/italic/size/color/…) on a text target. occurrence is zero-based.",
    inputSchema: op(
      {
        target: textTarget,
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        fontSizeHalfPoints: { type: "number" },
        fontFamily: { type: "string" },
        clearBold: { type: "boolean" },
        color: { type: "string" },
        clearColor: { type: "boolean" },
        underline: { type: "boolean" },
        clearUnderline: { type: "boolean" },
        highlight: { type: "string" },
        clearHighlight: { type: "boolean" },
        strikethrough: { type: "boolean" },
        clearStrikethrough: { type: "boolean" },
        verticalAlignment: {
          type: "string",
          enum: ["baseline", "superscript", "subscript"],
        },
        clearVerticalAlignment: { type: "boolean" },
      },
      ["target"],
    ),
  },
  set_table_cells_text: {
    description:
      "Atomically update table cells. Prefer cell handles from inspect(tables). Each update needs target + expectedCurrentText + replacement.",
    inputSchema: op(
      {
        table: tableTarget,
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: cellTarget,
              expectedCurrentText: { type: "string" },
              replacement: { type: "string" },
            },
            required: ["target", "expectedCurrentText", "replacement"],
            additionalProperties: false,
          },
        },
      },
      ["table", "updates"],
    ),
  },
  insert_table_rows: {
    description: "Insert rows after a table row anchor.",
    inputSchema: op(
      { table: tableTarget, after: rowAnchor, rows: stringRows },
      ["table", "after", "rows"],
    ),
  },
  insert_table_row: {
    description: "Insert a single table row after an anchor.",
    inputSchema: op(
      { table: tableTarget, after: rowAnchor, cells: strings },
      ["table", "after", "cells"],
    ),
  },
  insert_table_column: {
    description: "Insert a table column (header + one cell per existing row).",
    inputSchema: op(
      {
        table: tableTarget,
        header: { type: "string" },
        cells: strings,
        afterColumnHeader: { type: "string" },
        afterColumnHandle: { type: "string" },
      },
      ["table", "header", "cells"],
    ),
  },
  create_table: {
    description: "Create a table at a paragraph placement.",
    inputSchema: op({ rows: stringRows, placement }, ["rows", "placement"]),
  },
  delete_table: {
    description: "Delete a table.",
    inputSchema: op({ table: tableTarget }, ["table"]),
  },
  delete_table_row: {
    description: "Delete a table row.",
    inputSchema: op({ table: tableTarget, row: rowAnchor }, ["table", "row"]),
  },
  delete_table_column: {
    description: "Delete a table column by header or column handle.",
    inputSchema: op(
      {
        table: tableTarget,
        columnHeader: { type: "string" },
        columnHandle: { type: "string" },
      },
      ["table"],
    ),
  },
  set_table_formatting: {
    description: "Set table alignment/margins/borders.",
    inputSchema: op(
      {
        table: tableTarget,
        alignment: {
          type: "string",
          enum: ["left", "center", "right", "clear"],
        },
        cellMarginTopTwips: { type: "number" },
        cellMarginRightTwips: { type: "number" },
        cellMarginBottomTwips: { type: "number" },
        cellMarginLeftTwips: { type: "number" },
        borders: { type: "string", enum: ["grid", "none", "clear"] },
      },
      ["table"],
    ),
  },
  set_table_column_widths: {
    description: "Set table column widths in twips.",
    inputSchema: op(
      {
        table: tableTarget,
        widthsTwips: { type: "array", items: { type: "number" } },
      },
      ["table", "widthsTwips"],
    ),
  },
  set_table_cell_shading: {
    description: "Set table cell fill/shading. Omit fill to clear.",
    inputSchema: op(
      {
        table: tableTarget,
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: cellTarget,
              fill: { type: "string" },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
      },
      ["table", "updates"],
    ),
  },
  set_content_control_text: {
    description: "Set content-control text by tag and/or alias.",
    inputSchema: op(
      {
        target: {
          type: "object",
          properties: {
            tag: { type: "string" },
            alias: { type: "string" },
            occurrence: occurrenceField,
          },
          additionalProperties: false,
        },
        expectedCurrentText: { type: "string" },
        replacement: { type: "string" },
      },
      ["target", "expectedCurrentText", "replacement"],
    ),
  },
  set_paragraphs_list: {
    description: "Apply list formatting to one or more paragraph text targets.",
    inputSchema: op(
      {
        targets: { type: "array", items: textTarget },
        kind: { type: "string", enum: ["bullet", "decimal", "none"] },
        level: { type: "number", enum: [0, 1, 2] },
        continueFromPrevious: { type: "boolean" },
      },
      ["targets", "kind"],
    ),
  },
  set_hyperlink: {
    description: "Add or clear an external hyperlink on a text target.",
    inputSchema: op(
      {
        target: textTarget,
        url: {
          type: "string",
          description: "External URL. Omit to clear the hyperlink.",
        },
      },
      ["target"],
    ),
  },
  delete_picture: {
    description: "Delete a picture by handle from inspect(body_blocks).",
    inputSchema: op({ handle: { type: "string" } }, ["handle"]),
  },
  set_picture_size: {
    description:
      "Resize a picture. Supply exactly one of widthEmu or heightEmu.",
    inputSchema: op(
      {
        handle: { type: "string" },
        widthEmu: { type: "number" },
        heightEmu: { type: "number" },
      },
      ["handle"],
    ),
  },
  insert_page_break: {
    description: "Insert a page break at a paragraph placement.",
    inputSchema: op({ placement }, ["placement"]),
  },
  delete_page_break: {
    description: "Delete a page break by body_blocks handle.",
    inputSchema: op({ handle: { type: "string" } }, ["handle"]),
  },
  set_page_setup: {
    description: "Update page margins/size/orientation when section props exist.",
    inputSchema: op({
      topMarginTwips: { type: "number" },
      rightMarginTwips: { type: "number" },
      bottomMarginTwips: { type: "number" },
      leftMarginTwips: { type: "number" },
      paperSize: { type: "string", enum: ["letter", "a4"] },
      orientation: { type: "string", enum: ["portrait", "landscape"] },
    }),
  },
  set_header_footer_text: {
    description: "Set or clear header/footer text.",
    inputSchema: op(
      {
        kind: { type: "string", enum: ["header", "footer"] },
        text: {
          type: "string",
          description: "Omit to clear the text.",
        },
      },
      ["kind"],
    ),
  },
  set_page_number: {
    description: "Set or remove page-number fields in header/footer.",
    inputSchema: op(
      {
        kind: { type: "string", enum: ["header", "footer"] },
        alignment: {
          type: "string",
          enum: ["left", "center", "right"],
          description: "Omit to remove the page number.",
        },
      },
      ["kind"],
    ),
  },
};

/** Capabilities with a real model schema + dispatcher path. Sorted. */
export const MODEL_MUTATION_CAPABILITIES = Object.freeze(
  Object.keys(MUTATION_DEFS).sort(),
);

/** Binary-only; dispatchable via host but never model-exposed. */
export const HIDDEN_BINARY_MUTATION_CAPABILITIES = Object.freeze([
  "insert_picture",
  "replace_picture",
] as const);

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

/** V3 AgentTools for the live loop. Names match product progress labels. */
export function createDocumentTools(document: BoundDocumentHost): AgentToolSet {
  const caps = docxCapabilitySet(document.capabilities());
  const tools: AgentToolSet = {
    "document.capabilities": defineTool({
      kind: "read",
      description: "List real DOCX engine capabilities for the bound document.",
      inputSchema: emptyInput,
      execute: async () => document.capabilities(),
    }),
  };

  if (caps.has(READ_CAPS.inspect)) {
    tools["document.inspect"] = defineTool({
      kind: "read",
      description:
        "Inspect the bound DOCX (overview, headings, paragraphs, tables, body_blocks, or context).",
      inputSchema: inspectInput,
      execute: async (input) =>
        document.inspect({ focus: toInspectFocus(input) }),
    });
  }

  if (caps.has(READ_CAPS.find)) {
    tools["document.find"] = defineTool({
      kind: "read",
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
      tools[toolName] = defineTool({
        kind: "mutate",
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (input) =>
          mutate(capability, (input ?? {}) as Record<string, unknown>),
      });
    }
  }

  return tools;
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
