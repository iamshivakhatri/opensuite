import { jsonSchema, tool, type ToolSet } from "ai";

/**
 * Minimal read host for Phase 2A document tools.
 * API binds exact version bytes + engine; V2 never sees IDs/storage.
 */
export interface BoundDocumentReads {
  capabilities(): unknown;
  inspect(request: { readonly focus: InspectFocus }): Promise<unknown>;
  find(request: { readonly text: string }): Promise<unknown>;
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

/** AI SDK tools for the Phase-1 loop. Names match product progress labels. */
export function createDocumentTools(document: BoundDocumentReads): ToolSet {
  return {
    "document.capabilities": tool({
      description: "List real DOCX engine capabilities for the bound document.",
      inputSchema: emptyInput,
      execute: async () => document.capabilities(),
    }),
    "document.inspect": tool({
      description:
        "Inspect the bound DOCX (overview, headings, paragraphs, tables, body_blocks, or context).",
      inputSchema: inspectInput,
      execute: async (input) =>
        document.inspect({ focus: toInspectFocus(input) }),
    }),
    "document.find": tool({
      description: "Find exact text occurrences in the bound DOCX.",
      inputSchema: findInput,
      execute: async ({ text }) => document.find({ text }),
    }),
  };
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
