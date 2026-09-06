import {
  Capabilities,
  createCapabilities,
  hasCapability,
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
  type DocumentOperation,
  type DocumentRuntime,
  type FindResult,
  type InspectionResult,
  type OperationFailureCode,
  type OperationResult,
  type RuntimeCapabilities,
  type Diagnostic,
  type DiagnosticSeverity,
  type NonEmptyDiagnostics,
} from "@opensuite/agent-core";

import type { DocumentArtifactLoader } from "./document-artifact-loader.js";
import type {
  DocxEngineBinding,
  DocxEngineDiagnostic,
  DocxReplaceTextOperation,
} from "./docx-engine-binding.js";

/**
 * Real DocumentRuntime backed by opensuite-engine's Node DOCX binding.
 *
 * Proven path (this milestone):
 *   DocumentRuntime.execute(document.replace_text)
 *     → load exact version bytes
 *     → N-API executeDocxReplaceText
 *     → verified artifactBytes | structured failure
 *
 * Read-side inspect/find remain mock/runtime concerns until engine inspect
 * is bound — this adapter advertises mutate only by default.
 */
export interface OpenSuiteEngineAdapterOptions {
  readonly artifactLoader: DocumentArtifactLoader;
  readonly binding: DocxEngineBinding;
  /** Override advertised capabilities (default: document.mutate only). */
  readonly capabilities?: RuntimeCapabilities;
}

const DEFAULT_CAPABILITIES = createCapabilities(Capabilities.DocumentMutate);

export function createOpenSuiteEngineAdapter(
  options: OpenSuiteEngineAdapterOptions,
): DocumentRuntime {
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const { artifactLoader, binding } = options;

  return {
    capabilities() {
      return capabilities;
    },

    async inspect(document, inspectOptions): Promise<InspectionResult> {
      throwIfAborted(inspectOptions?.signal);
      if (!hasCapability(capabilities, Capabilities.DocumentInspect)) {
        return unsupportedCapabilityResult(Capabilities.DocumentInspect);
      }
      void document;
      return unsupportedCapabilityResult(Capabilities.DocumentInspect);
    },

    async find(document, query, findOptions): Promise<FindResult> {
      throwIfAborted(findOptions?.signal);
      if (!hasCapability(capabilities, Capabilities.DocumentFind)) {
        return unsupportedCapabilityFind(Capabilities.DocumentFind);
      }
      void document;
      void query;
      return unsupportedCapabilityFind(Capabilities.DocumentFind);
    },

    async execute(
      document,
      operation,
      executeOptions,
    ): Promise<OperationResult> {
      throwIfAborted(executeOptions?.signal);
      if (!hasCapability(capabilities, Capabilities.DocumentMutate)) {
        return unsupportedCapabilityOperation(Capabilities.DocumentMutate);
      }

      if (document.format !== "docx") {
        return operationError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX mutations (got ${document.format})`,
          { format: document.format },
        );
      }

      if (operation.baseVersionId !== document.versionId) {
        return operationError(
          "CONFLICT",
          "baseDocumentVersionId does not match DocumentRef.versionId",
          {
            baseVersionId: operation.baseVersionId,
            versionId: document.versionId,
          },
        );
      }

      if (operation.type !== "document.replace_text") {
        return operationError(
          "UNSUPPORTED_CAPABILITY",
          `Unsupported mutation type for OpenSuiteEngineAdapter: ${operation.type}`,
          { type: operation.type },
        );
      }

      const mapped = mapReplaceTextOperation(operation);
      if (!mapped.ok) {
        return mapped.error;
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);
      const engineResponse = await binding.executeDocxReplaceText(
        inputBytes,
        mapped.operation,
      );

      return mapEngineReplaceTextResult(engineResponse, operation.type);
    },
  };
}

/** Exported for unit tests — application DTO → binding DTO only. */
export function mapReplaceTextOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxReplaceTextOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const payload = operation.payload;
  const targetText = readNonEmptyString(
    payload.targetText ??
      (isRecord(payload.target) ? payload.target.text : undefined) ??
      payload.find,
  );
  if (targetText === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.replace_text requires non-empty target text (payload.find or payload.targetText)",
      ),
    };
  }

  const replacement = readString(payload.replacement ?? payload.replace);
  if (replacement === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.replace_text requires payload.replacement or payload.replace",
      ),
    };
  }

  const expectedCurrentText =
    readString(payload.expectedCurrentText) ?? targetText;

  const occurrenceRaw = payload.occurrence;
  let occurrence: number | undefined;
  if (occurrenceRaw !== undefined) {
    if (
      typeof occurrenceRaw !== "number" ||
      !Number.isInteger(occurrenceRaw) ||
      occurrenceRaw < 1
    ) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.replace_text payload.occurrence must be a positive integer when provided",
        ),
      };
    }
    occurrence = occurrenceRaw;
  }

  return {
    ok: true,
    operation: {
      target: {
        text: targetText,
        ...(occurrence !== undefined ? { occurrence } : {}),
      },
      expectedCurrentText,
      replacement,
      // Opaque metadata only — does not enforce application concurrency.
      baseRevision: operation.baseVersionId,
    },
  };
}

function mapEngineReplaceTextResult(
  response: {
    readonly result: {
      readonly ok: boolean;
      readonly status: string;
      readonly diagnostics: readonly DocxEngineDiagnostic[];
      readonly changes: readonly {
        readonly kind: string;
        readonly before: string;
        readonly after: string;
      }[];
    };
    readonly output?: Uint8Array;
  },
  operationType: string,
): OperationResult {
  const diagnostics = response.result.diagnostics.map(mapDiagnostic);
  const firstError = diagnostics.find((d) => d.severity === "error");

  if (!response.result.ok) {
    // Failure must never surface artifact bytes.
    const rawCode = firstError?.code ?? "VALIDATION_FAILED";
    const code = normalizeFailureCode(rawCode);
    return {
      status: "error",
      code,
      diagnostics: ensureNonEmpty(
        diagnostics.map((d) =>
          d.code === rawCode && code !== rawCode ? { ...d, code } : d,
        ),
        code,
        `Engine mutation failed with status ${response.result.status}`,
      ),
    };
  }

  if (!response.output || response.output.byteLength === 0) {
    return operationError(
      "DOCUMENT_INVALID",
      "Engine reported success but returned no verified output artifact",
    );
  }

  const change = response.result.changes[0];
  return {
    status: "success",
    diagnostics,
    change: change
      ? {
          operation: operationType,
          area: change.kind || "text",
          before: change.before,
          after: change.after,
        }
      : {
          operation: operationType,
          area: "text",
          before: "",
          after: "",
        },
    artifactBytes: response.output,
  };
}

function normalizeFailureCode(code: string): OperationFailureCode {
  if (code === "INVALID_ZIP" || code === "UNSUPPORTED_OPERATION") {
    return code === "INVALID_ZIP" ? "DOCUMENT_INVALID" : "UNSUPPORTED_CAPABILITY";
  }
  return code as OperationFailureCode;
}

function mapDiagnostic(diagnostic: DocxEngineDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    severity: normalizeSeverity(diagnostic.severity),
    message: diagnostic.message,
  };
}

function normalizeSeverity(value: string): DiagnosticSeverity {
  if (value === "warning" || value === "info" || value === "error") {
    return value;
  }
  return "error";
}

function ensureNonEmpty(
  diagnostics: readonly Diagnostic[],
  code: string,
  message: string,
): NonEmptyDiagnostics {
  if (diagnostics.length > 0) {
    return diagnostics as NonEmptyDiagnostics;
  }
  return [{ code, severity: "error", message }];
}

function operationError(
  code: OperationFailureCode,
  message: string,
  details?: Record<string, unknown>,
): OperationResult {
  return {
    status: "error",
    code,
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        ...(details ? { details } : {}),
      },
    ],
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("DocumentRuntime operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const text = readString(value);
  if (text === null || text.length === 0) return null;
  return text;
}

/** Test helper: assert no engine/source identity keys on a result. */
export function assertNoEngineSourceIdentities(value: unknown): void {
  const forbidden = [
    "nodeId",
    "NodeId",
    "sourceSpan",
    "SourceSpan",
    "partName",
    "relationshipId",
    "xmlPath",
    "byteOffset",
  ];
  const seen = JSON.stringify(value);
  for (const key of forbidden) {
    if (seen.includes(`"${key}"`)) {
      throw new Error(`Engine/source identity leaked via key ${key}`);
    }
  }
}
