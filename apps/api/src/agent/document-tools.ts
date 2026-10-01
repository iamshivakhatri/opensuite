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
  mutateBatch?(
    capability: string,
    operations: readonly Record<string, unknown>[],
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
    "Use start/end without a handle at document boundaries, including initial content in a blank document (which has no handles). For before/after, use only a handle from the latest relevant document.inspect; never invent one. Formatting preserves handles within one model turn; handles expire before the next model turn or after other edits.",
  properties: {
    kind: { type: "string", enum: ["start", "end", "before", "after"], description: "start/end need no handle; before/after need an inspected body_blocks handle." },
    handle: {
      type: "string",
      description: "Omit for start/end. Required for before/after; copy from the latest relevant document.inspect.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const tableTarget = {
  type: "object",
  description:
    "Use exact current headerCells and occurrence when known. Inspect for a missing selector or needed handle. Handles survive read-only turns; content/structure edits clear them immediately, while formatting edits may preserve them only within the edited turn. Occurrence is zero-based.",
  properties: {
    handle: { type: "string" },
    headerCells: { type: "array", items: { type: "string" } },
    occurrence: occurrenceField,
  },
  additionalProperties: false,
};

const rowAnchor = {
  type: "object",
  description: "Row selector. Use firstCellText/occurrence when unambiguous; inspect only when a current row handle is needed.",
  properties: {
    handle: { type: "string" },
    firstCellText: { type: "string" },
    occurrence: occurrenceField,
  },
  additionalProperties: false,
};

const semanticRowTarget = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["header", "label", "index"] },
    text: { type: "string", description: "First-cell row label for kind=label." },
    occurrence: occurrenceField,
    index: { type: "integer", description: "Zero-based row position for kind=index." },
    expectedFirstCellText: { type: "string", description: "Required for kind=index; prevents a shifted row from being edited." },
  },
  required: ["kind"],
  additionalProperties: false,
};

const deleteRowTarget = {
  type: "object",
  description: "Prefer kind=label with text and occurrence when needed, or kind=index with expectedFirstCellText. Use a handle only when these cannot express the row. Older firstCellText + occurrence remains supported.",
  properties: { ...semanticRowTarget.properties, ...rowAnchor.properties },
  additionalProperties: false,
};

const semanticCellTarget = {
  type: "object",
  description: "Prefer row + column. Use a handle only when these selectors cannot express the cell. Legacy rowLabel + columnHeader remains supported for data cells.",
  properties: {
    row: semanticRowTarget,
    column: { type: "object", properties: {
      kind: { type: "string", enum: ["first", "header", "index"] },
      text: { type: "string", description: "First-row column header for kind=header." },
      occurrence: occurrenceField,
      index: { type: "integer", description: "Zero-based column position for kind=index." },
      expectedHeaderText: { type: "string", description: "Required for kind=index; prevents a shifted column from being edited." },
    }, required: ["kind"], additionalProperties: false },
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
      "Replace one exact text span. Requires target text, zero-based occurrence when ambiguous, expectedCurrentText (must match current content), and replacement.",
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
    description:
      "Insert one paragraph. For a blank document, use placement {kind: \"end\"} or {kind: \"start\"} without a handle.",
    inputSchema: op({ text: { type: "string" }, placement }, [
      "text",
      "placement",
    ]),
  },
  insert_paragraphs: {
    description:
      "Insert multiple paragraphs. For a blank document, use placement {kind: \"end\"} or {kind: \"start\"} without a handle.",
    inputSchema: op({ texts: strings, placement }, ["texts", "placement"]),
  },
  delete_paragraph: {
    description:
      "Delete a paragraph identified by exact text target (occurrence zero-based when ambiguous).",
    inputSchema: op({ target: textTarget }, ["target"]),
  },
  set_paragraph_style: {
    description:
      "Set or clear a direct body paragraph style by display name (e.g. 'Heading 1'), not styleId. Does not format table cells. Target via exact text + zero-based occurrence. Omit style to clear.",
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
    description:
      "Set alignment, spacing, or indent on a direct body paragraph, not a table cell (occurrence zero-based when ambiguous).",
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
      "Format exact body text or partial text spans, including supported simple table-cell runs. For known whole table cells, use set_table_cells_formatting. Occurrence is zero-based when ambiguous.",
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
      "Update known cells in one table. Select each by row (header, label, or checked index) and column (first, header, or checked index); use occurrence for duplicate labels. All selectors use the original table state, so headers and row labels can change in this call. Each update needs expectedCurrentText and replacement.",
    inputSchema: op(
      {
        table: tableTarget,
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: semanticCellTarget,
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
    description: "Insert several contiguous, known rows in one call after a row anchor; prefer this over repeated insert_table_row calls.",
    inputSchema: op(
      { table: tableTarget, after: rowAnchor, rows: stringRows },
      ["table", "after", "rows"],
    ),
  },
  insert_table_row: {
    description: "Insert one table row after an anchor; use insert_table_rows when several contiguous rows are known.",
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
    description: "Delete a known table row using table + row. Prefer row {kind: 'label', text, occurrence?} or a checked index; a handle is only needed when these cannot express the row.",
    inputSchema: op({ table: tableTarget, row: deleteRowTarget }, ["table", "row"]),
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
    description: "Shade known table cells in one call using table + row + column, including header and first-column cells. Fill is 6-digit RGB without #; omit fill to clear. Use set_table_cells_formatting for fill and text together.",
    inputSchema: op(
      {
        table: tableTarget,
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: semanticCellTarget,
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
  set_table_cells_formatting: {
    description:
      "Format known whole table cells using table + row + column, including header and first-column cells, without find or inspect handles. Format all relevant cells in one call; set fill and direct text formatting together when needed. Supports fill (6-digit RGB), bold, italic, font family, font size in half-points, and text color. Handles remain available for cells that need them.",
    inputSchema: op(
      {
        table: tableTarget,
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              target: semanticCellTarget,
              fill: { type: "string" },
              textFormatting: {
                type: "object",
                properties: {
                  bold: { type: "boolean" },
                  italic: { type: "boolean" },
                  fontFamily: { type: "string" },
                  fontSizeHalfPoints: { type: "number" },
                  color: { type: "string" },
                },
                additionalProperties: false,
              },
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
    description:
      "Delete a picture identified by an opaque body_blocks handle.",
    inputSchema: op({ handle: { type: "string" } }, ["handle"]),
  },
  set_picture_size: {
    description:
      "Resize a picture by opaque handle. Supply exactly one of widthEmu or heightEmu.",
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
    description:
      "Insert a page break at a paragraph placement (start/end/before/after).",
    inputSchema: op({ placement }, ["placement"]),
  },
  delete_page_break: {
    description: "Delete a page break identified by an opaque body_blocks handle.",
    inputSchema: op({ handle: { type: "string" } }, ["handle"]),
  },
  set_page_setup: {
    description:
      "Update section page margins, paper size (letter/a4), or orientation when section properties exist.",
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

const BATCH_TOOLS = {
  replace_text: "batch_replace_text",
  set_paragraph_style: "batch_paragraph_styles",
  set_paragraph_formatting: "batch_paragraph_formatting",
  set_text_formatting: "batch_text_formatting",
} as const;

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
  const tools: AgentToolSet = {};

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

  if (document.mutateBatch) {
    const mutateBatch = document.mutateBatch.bind(document);
    for (const [capability, name] of Object.entries(BATCH_TOOLS)) {
      if (!caps.has(capability)) continue;
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
              items: MUTATION_DEFS[capability]!.inputSchema.jsonSchema,
            },
          },
          required: ["operations"],
          additionalProperties: false,
        }),
        execute: async ({ operations }) => mutateBatch(capability, operations),
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
