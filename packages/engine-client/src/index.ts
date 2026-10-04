export * from "./transport.js";
export * from "./engine-client.js";
export * from "./mock-transport.js";
export * from "./docx-engine-binding.js";
export * from "./docx-style-snapshot.js";
export {
  bindDocxDocument,
  DISPATCHABLE_MUTATION_CAPABILITIES,
  MutationArgError,
  type BoundDocxDocument,
  type DispatchableMutationCapability,
} from "./bound-docx.js";
export {
  buildDocxBody,
  buildMinimalDocx,
  buildNameRoleTableDocx,
} from "./__fixtures__/minimal-docx.js";
export type { DocxBodyBlock } from "./__fixtures__/minimal-docx.js";
