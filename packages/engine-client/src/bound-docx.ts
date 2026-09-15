import type {
  DocxEngineBinding,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInspectRequest,
  DocxInspectResult,
  DocxRuntimeCapabilities,
} from "./docx-engine-binding.js";

/**
 * Server-bound DOCX document: bytes + engine binding.
 * Tools call this; the model never chooses document/version IDs.
 */
export function bindDocxDocument(input: {
  readonly binding: DocxEngineBinding;
  readonly bytes: Uint8Array;
}) {
  const { binding, bytes } = input;
  return {
    capabilities(): DocxRuntimeCapabilities {
      return binding.getDocxCapabilities();
    },
    inspect(request: DocxInspectRequest): Promise<DocxInspectResult> {
      return binding.inspectDocx(bytes, request);
    },
    find(request: DocxFindTextRequest): Promise<DocxFindTextResult> {
      return binding.findDocxText(bytes, request);
    },
  };
}

export type BoundDocxDocument = ReturnType<typeof bindDocxDocument>;
