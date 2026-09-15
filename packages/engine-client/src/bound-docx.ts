import type {
  DocxEngineBinding,
  DocxEngineDiagnostic,
  DocxEngineOperationResult,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInspectRequest,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxRuntimeCapabilities,
} from "./docx-engine-binding.js";
import { MutationArgError } from "./docx-engine-binding.js";
import { dispatchMutation } from "./mutation-dispatch.js";

export { MutationArgError } from "./docx-engine-binding.js";
export {
  DISPATCHABLE_MUTATION_CAPABILITIES,
  type DispatchableMutationCapability,
} from "./mutation-dispatch.js";

export interface BoundDocxPersistInput {
  readonly bytes: Uint8Array;
  readonly baseVersionId: string;
}

export interface BoundDocxPersistResult {
  readonly versionId: string;
  readonly versionNumber?: number;
}

export interface BoundDocxMutationResult {
  readonly ok: boolean;
  readonly capability: string;
  readonly status: string;
  readonly reasonCode?: string;
  readonly diagnostics: readonly DocxEngineDiagnostic[];
  readonly changes?: DocxEngineOperationResult["changes"];
  /** Present only after successful persist (or in-memory advance when no persist). */
  readonly versionId?: string;
  readonly versionNumber?: number;
}

/**
 * Server-bound DOCX document: evolving bytes + engine binding.
 * Tools call this; the model never chooses document/version IDs.
 *
 * Writes run through Rust, then an application persist callback advances
 * the immutable version. Sibling writes see updated bytes sequentially.
 */
export function bindDocxDocument(input: {
  readonly binding: DocxEngineBinding;
  readonly bytes: Uint8Array;
  readonly versionId?: string;
  readonly persist?: (
    next: BoundDocxPersistInput,
  ) => Promise<BoundDocxPersistResult>;
}) {
  const { binding, persist } = input;
  let bytes = input.bytes;
  let versionId = input.versionId;

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
    currentVersionId(): string | undefined {
      return versionId;
    },
    async mutate(
      capability: string,
      operation: Record<string, unknown>,
    ): Promise<BoundDocxMutationResult> {
      let engine: DocxMutationBindingResult;
      try {
        engine = await dispatchMutation(binding, bytes, capability, operation);
      } catch (error) {
        if (error instanceof MutationArgError) {
          return compactValidationFailure(capability, error.message);
        }
        const message =
          error instanceof Error ? error.message : "Mutation dispatch failed";
        return {
          ok: false,
          capability,
          status: "error",
          reasonCode: "DISPATCH_FAILED",
          diagnostics: [
            {
              code: "DISPATCH_FAILED",
              severity: "error",
              message,
              reasonCode: "DISPATCH_FAILED",
              operation: capability,
            },
          ],
        };
      }

      if (!engine.result.ok || !engine.output || engine.output.byteLength === 0) {
        return compactEngineFailure(capability, engine.result);
      }

      if (persist) {
        if (!versionId) {
          return {
            ok: false,
            capability,
            status: "error",
            reasonCode: "MISSING_BASE_VERSION",
            diagnostics: [
              {
                code: "MISSING_BASE_VERSION",
                severity: "error",
                message: "Bound document has no versionId for persistence",
                reasonCode: "MISSING_BASE_VERSION",
                operation: capability,
              },
            ],
          };
        }
        try {
          const saved = await persist({
            bytes: engine.output,
            baseVersionId: versionId,
          });
          bytes = engine.output;
          versionId = saved.versionId;
          return {
            ok: true,
            capability,
            status: engine.result.status,
            diagnostics: engine.result.diagnostics,
            changes: engine.result.changes,
            versionId: saved.versionId,
            ...(saved.versionNumber !== undefined
              ? { versionNumber: saved.versionNumber }
              : {}),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Persistence failed";
          return {
            ok: false,
            capability,
            status: "error",
            reasonCode: "PERSISTENCE_FAILED",
            diagnostics: [
              {
                code: "PERSISTENCE_FAILED",
                severity: "error",
                message,
                reasonCode: "PERSISTENCE_FAILED",
                operation: capability,
              },
            ],
          };
        }
      }

      // No persist callback (tests): advance in-memory bytes only.
      bytes = engine.output;
      return {
        ok: true,
        capability,
        status: engine.result.status,
        diagnostics: engine.result.diagnostics,
        changes: engine.result.changes,
        ...(versionId !== undefined ? { versionId } : {}),
      };
    },
  };
}

export type BoundDocxDocument = ReturnType<typeof bindDocxDocument>;

function compactValidationFailure(
  capability: string,
  message: string,
): BoundDocxMutationResult {
  return {
    ok: false,
    capability,
    status: "error",
    reasonCode: "VALIDATION_FAILED",
    diagnostics: [
      {
        code: "VALIDATION_FAILED",
        severity: "error",
        message,
        reasonCode: "VALIDATION_FAILED",
        operation: capability,
      },
    ],
  };
}

function compactEngineFailure(
  capability: string,
  result: DocxEngineOperationResult,
): BoundDocxMutationResult {
  const reasonCode =
    result.diagnostics.find((d) => d.reasonCode)?.reasonCode ??
    result.diagnostics[0]?.code;
  return {
    ok: false,
    capability,
    status: result.status,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    diagnostics: result.diagnostics,
    changes: result.changes,
  };
}
