import Ajv, { type ValidateFunction } from "ajv";
import legacyInputs from "./legacy-docx-inputs.json" with { type: "json" };

/** Engine-authored transport input; the product owns document access and persistence. */
export interface DocxOperationDefinition {
  readonly id: string;
  readonly kind: "read" | "mutate" | "create";
  readonly nodeExport: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly jsonInput: boolean;
  readonly jsonOutput: boolean;
}

// Generated from Rust for engines predating input metadata. Never edit by hand.
const legacyOperations = legacyInputs as readonly DocxOperationDefinition[];
export const DOCX_MUTATION_CAPABILITIES = Object.freeze(legacyOperations.filter(op => op.kind === "mutate").map(op => op.id).sort());
const validator = new Ajv({ strict: false });
const validators = new WeakMap<DocxOperationDefinition, ValidateFunction>();

/** New engines supply their own contracts; old engines use the generated compatibility snapshot. */
export function docxOperationDefinitions(capabilities: unknown): readonly DocxOperationDefinition[] {
  const formats = (capabilities as { formats?: { format: string; capabilities: string[]; operations?: unknown[] }[] })?.formats;
  const docx = formats?.find(format => format.format === "docx");
  if (!docx) return [];
  const allowed = new Set(docx.capabilities);
  const source = docx.operations ?? legacyOperations;
  return source.filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
    .filter(value => allowed.has(value.id as string))
    .map(value => {
      const legacy = legacyOperations.find(op => op.id === value.id && (!value.nodeExport || op.nodeExport === value.nodeExport));
      const schema = typeof value.inputSchema === "string" ? JSON.parse(value.inputSchema) : value.inputSchema ?? legacy?.inputSchema;
      if (typeof value.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(value.id) ||
          !["read", "mutate", "create"].includes(value.kind as string) ||
          typeof value.nodeExport !== "string" || !schema || schema.type !== "object" || !schema.properties) {
        throw new Error(`Engine operation ${String(value.id)} has no valid input definition`);
      }
      return {
        id: value.id, kind: value.kind as DocxOperationDefinition["kind"], nodeExport: value.nodeExport,
        description: typeof value.description === "string" ? value.description : legacy?.description ?? value.id,
        inputSchema: schema,
        jsonInput: typeof value.jsonInput === "boolean" ? value.jsonInput : legacy?.jsonInput ?? false,
        jsonOutput: typeof value.jsonOutput === "boolean" ? value.jsonOutput : legacy?.jsonOutput ?? false,
      };
    });
}

/** Remove API-owned revision metadata and client-supplied defaults from the model's required inputs. */
export function docxAgentInputSchema(definition: DocxOperationDefinition): Record<string, unknown> {
  const schema = definition.inputSchema;
  const properties = { ...(schema.properties as Record<string, Record<string, unknown>>) };
  delete properties.baseRevision;
  const required = (schema.required as string[] ?? []).filter(key => key !== "baseRevision" && !properties[key]?.["x-client-default"]);
  return { ...schema, properties, required };
}

export function prepareDocxOperationInput(definition: DocxOperationDefinition, input: Record<string, unknown>): Record<string, unknown> {
  const value = { ...input };
  const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  for (const [key, schema] of Object.entries(properties)) {
    if (schema["x-client-default"] === "currentUtc" && value[key] === undefined) value[key] = new Date().toISOString();
  }
  return value;
}

export function docxOperationInputError(definition: DocxOperationDefinition, input: Record<string, unknown>): string | null {
  let validate = validators.get(definition);
  if (!validate) {
    validate = validator.compile(definition.inputSchema);
    validators.set(definition, validate);
  }
  return validate(input) ? null : validator.errorsText(validate.errors);
}
