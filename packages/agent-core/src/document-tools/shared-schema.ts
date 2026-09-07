/**
 * Shared JSON-schema fragments and request-shape parse helpers.
 * Shape validation only — document semantics belong to Rust.
 */

import { AgentCoreError } from "../errors.js";
import { parseOptionalOccurrence } from "../occurrence.js";

/** Opaque artifact-local structural handle from inspect. Never persist across versions. */
export type StructuralHandle = string;

/** Shared 1-based occurrence property (omit / null / "" / 0 → omitted at parse). */
export const OCCURRENCE_PROPERTY = {
  type: "number",
  description:
    "Version-local 1-based occurrence when targets collide; omit when unique (never send 0)",
} as const;

/** Semantic text target (engine TextTarget) — not a structural handle. */
export const TEXT_TARGET_SCHEMA = {
  type: "object",
  description:
    "Locate a paragraph/run by exact visible text (optional 1-based occurrence)",
  properties: {
    text: {
      type: "string",
      description: "Exact visible text to match",
    },
    occurrence: OCCURRENCE_PROPERTY,
  },
  required: ["text"],
  additionalProperties: false,
} as const;

export const STRUCTURAL_HANDLE_PROPERTY = {
  type: "string",
  description:
    "Opaque artifact-local handle from document.inspect(tables); never persist across versions",
} as const;

export const TABLE_TARGET_PROPERTIES = {
  headerCells: {
    type: "array",
    items: { type: "string" },
    description: "Exact header cell texts in order (semantic selector)",
  },
  occurrence: OCCURRENCE_PROPERTY,
  handle: {
    type: "string",
    description:
      "Opaque table handle from inspect(tables); preferred when tables share headers",
  },
} as const;

export function tableTargetSchema(options?: {
  readonly description?: string;
  readonly requireHeaderCells?: boolean;
}): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { ...TABLE_TARGET_PROPERTIES },
    additionalProperties: false,
  };
  if (options?.description !== undefined) {
    schema.description = options.description;
  }
  if (options?.requireHeaderCells) {
    schema.required = ["headerCells"];
    schema.properties = {
      ...TABLE_TARGET_PROPERTIES,
      headerCells: {
        ...TABLE_TARGET_PROPERTIES.headerCells,
        description:
          "Exact header cell texts in order (required for column insert)",
      },
      handle: {
        type: "string",
        description: "Opaque table handle from inspect(tables)",
      },
      occurrence: { type: "number" },
    };
  }
  return schema;
}

export const ROW_ANCHOR_SCHEMA = {
  type: "object",
  description:
    "Insert after this row: firstCellText from inspection and/or opaque row handle",
  properties: {
    firstCellText: { type: "string" },
    occurrence: OCCURRENCE_PROPERTY,
    handle: {
      type: "string",
      description: "Opaque row handle from inspect(tables)",
    },
  },
  additionalProperties: false,
} as const;

export const PAGING_PROPERTIES = {
  offset: {
    type: "number",
    description: "0-based page offset for headings/paragraphs/tables (default 0)",
  },
  limit: {
    type: "number",
    description: "Page size for headings/paragraphs/tables (default 20, max 100)",
  },
} as const;

export function parseOptionalNonNegativeInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} must be a non-negative integer`,
    );
  }
  return value;
}

export function parseOptionalPositiveInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

export function parseOptionalString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AgentCoreError("INVALID_TOOL_INPUT", `${label} must be a string`);
  }
  return value;
}

export function parseNonEmptyString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !value) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} requires a non-empty string`,
    );
  }
  return value;
}

export function parseStringArray(
  value: unknown,
  label: string,
  options: { readonly nonEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} requires an array`,
    );
  }
  if (options.nonEmpty && value.length === 0) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} requires a non-empty array`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AgentCoreError(
        "INVALID_TOOL_INPUT",
        `${label} entries must be strings`,
      );
    }
    out.push(item);
  }
  return out;
}

/** Re-export occurrence parse for selector modules. */
export { parseOptionalOccurrence };
