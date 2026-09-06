import type { DocumentChangeSummary, DocumentRuntime } from "./runtime.js";
import type {
  Diagnostic,
  DocumentRef,
  NonEmptyDiagnostics,
} from "./types.js";

/**
 * Application-injected mutation boundary.
 *
 * Agent-core never persists versions itself. apps/api implements this by
 * calling createDocumentMutationService().applyReplaceText (engine once +
 * appendDocumentVersion). Success means an immutable version was written.
 */
export interface DocumentReplaceTextMutationRequest {
  readonly document: DocumentRef;
  readonly find: string;
  readonly replace: string;
  readonly expectedCurrentText?: string;
  readonly occurrence?: number;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export type DocumentMutationResult =
  | {
      readonly status: "success";
      /** Active document identity after persistence (version N+1). */
      readonly document: DocumentRef;
      readonly versionNumber?: number;
      readonly baseVersionId: string;
      readonly change?: DocumentChangeSummary;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "error";
      readonly code: string;
      readonly diagnostics: NonEmptyDiagnostics;
    };

export interface DocumentMutationExecutor {
  replaceText(
    input: DocumentReplaceTextMutationRequest,
  ): Promise<DocumentMutationResult>;
}

/**
 * Tool output for a successfully persisted replace_text.
 * Does not include artifactBytes — those belong to storage after persist.
 */
export interface PersistedReplaceTextToolResult {
  readonly status: "success";
  readonly diagnostics: readonly Diagnostic[];
  readonly change?: DocumentChangeSummary;
  readonly document: DocumentRef;
  readonly versionNumber?: number;
  readonly baseVersionId: string;
}

export function isPersistedReplaceTextToolResult(
  value: unknown,
): value is PersistedReplaceTextToolResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "success") return false;
  if (!record.document || typeof record.document !== "object") return false;
  const doc = record.document as Record<string, unknown>;
  return (
    typeof doc.documentId === "string" &&
    typeof doc.versionId === "string" &&
    typeof doc.format === "string" &&
    typeof record.baseVersionId === "string"
  );
}

/**
 * Test helper: run DocumentRuntime.execute once and synthesize a new version id.
 * Does not touch DB/storage — for agent-core unit tests only.
 */
export function createInMemoryDocumentMutationExecutor(
  runtime: DocumentRuntime,
): DocumentMutationExecutor {
  let sequence = 0;
  return {
    async replaceText(input) {
      if (!runtime.execute) {
        return {
          status: "error",
          code: "UNSUPPORTED_CAPABILITY",
          diagnostics: [
            {
              code: "UNSUPPORTED_CAPABILITY",
              severity: "error",
              message: "DocumentRuntime does not support execute/mutate",
            },
          ],
        };
      }
      const result = await runtime.execute(
        input.document,
        {
          type: "document.replace_text",
          baseVersionId: input.document.versionId,
          payload: {
            find: input.find,
            replace: input.replace,
            ...(input.expectedCurrentText !== undefined
              ? { expectedCurrentText: input.expectedCurrentText }
              : {}),
            ...(input.occurrence !== undefined
              ? { occurrence: input.occurrence }
              : {}),
          },
        },
        { signal: input.signal, runId: input.runId },
      );
      if (result.status === "error") {
        return {
          status: "error",
          code: result.code,
          diagnostics: result.diagnostics,
        };
      }
      sequence += 1;
      const next: DocumentRef = {
        documentId: input.document.documentId,
        versionId: `${input.document.versionId}+${sequence}`,
        format: input.document.format,
      };
      return {
        status: "success",
        document: next,
        versionNumber: sequence + 1,
        baseVersionId: input.document.versionId,
        ...(result.change !== undefined ? { change: result.change } : {}),
        diagnostics: result.diagnostics,
      };
    },
  };
}
