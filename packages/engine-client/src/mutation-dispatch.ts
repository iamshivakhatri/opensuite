import type { DocxEngineBinding, DocxMutationBindingResult } from "./docx-engine-binding.js";
import { DOCX_MUTATION_CAPABILITIES, docxOperationDefinitions } from "./docx-operation-inputs.js";

/** Compatibility inventory; live bindings dispatch from their engine metadata. */
export const DISPATCHABLE_MUTATION_CAPABILITIES = DOCX_MUTATION_CAPABILITIES;
export type DispatchableMutationCapability = string;

export async function dispatchMutation(
  binding: DocxEngineBinding, bytes: Uint8Array, capability: string, operation: Record<string, unknown>,
): Promise<DocxMutationBindingResult> {
  const definition = docxOperationDefinitions(binding.getDocxCapabilities()).find(op => op.id === capability && op.kind === "mutate");
  if (!definition) throw new Error(`Unsupported mutation capability: ${capability}`);
  if (definition.jsonInput && binding.executeDocxOperation) return binding.executeDocxOperation(bytes, capability, operation);
  const method = (binding as unknown as Record<string, unknown>)[definition.nodeExport];
  if (typeof method === "function") return method.call(binding, bytes, operation);
  if (binding.executeDocxExtended) return binding.executeDocxExtended(bytes, definition.nodeExport as Parameters<NonNullable<DocxEngineBinding["executeDocxExtended"]>>[1], operation);
  throw new Error(`${capability} requires a typed binary adapter`);
}
