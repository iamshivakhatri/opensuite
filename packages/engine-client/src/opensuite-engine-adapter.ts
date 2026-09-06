import {
  Capabilities,
  createCapabilities,
  hasCapability,
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
  type DocumentInspectFocus,
  type DocumentOperation,
  type DocumentRuntime,
  type FindMatch,
  type FindResult,
  type InspectionResult,
  type OperationFailureCode,
  type OperationResult,
  type RuntimeCapabilities,
  type Diagnostic,
  type DiagnosticSeverity,
  type NonEmptyDiagnostics,
  type DocumentRef,
} from "@opensuite/agent-core";

import type { DocumentArtifactLoader } from "./document-artifact-loader.js";
import type {
  DocxEngineBinding,
  DocxEngineDiagnostic,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
} from "./docx-engine-binding.js";

/**
 * Real DocumentRuntime backed by opensuite-engine's Node DOCX binding.
 *
 * Proven path:
 *   exact DocumentRef.versionId bytes
 *     → capabilities (Rust RuntimeCapabilities)
 *     → findDocxText / inspectDocx(context) / executeDocxReplaceText
 *
 * No mock semantic fallback for real DOCX execution. Unsupported inspect
 * focuses return structured UNSUPPORTED_OPERATION.
 */
export interface OpenSuiteEngineAdapterOptions {
  readonly artifactLoader: DocumentArtifactLoader;
  readonly binding: DocxEngineBinding;
  /**
   * Optional override. When omitted, capabilities are derived from
   * `binding.getDocxCapabilities()` (Rust is source of truth).
   */
  readonly capabilities?: RuntimeCapabilities;
}

export function createOpenSuiteEngineAdapter(
  options: OpenSuiteEngineAdapterOptions,
): DocumentRuntime {
  const { artifactLoader, binding } = options;
  const cachedCapabilities =
    options.capabilities ??
    mapRustCapabilitiesToRuntime(binding.getDocxCapabilities());

  return {
    capabilities() {
      return cachedCapabilities;
    },

    async inspect(document, inspectOptions): Promise<InspectionResult> {
      throwIfAborted(inspectOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentInspect)) {
        return unsupportedCapabilityResult(Capabilities.DocumentInspect);
      }

      if (document.format !== "docx") {
        return inspectionError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX inspect (got ${document.format})`,
          { format: document.format },
        );
      }

      const focus = inspectOptions?.focus ?? { kind: "overview" };
      if (focus.kind !== "context") {
        return inspectionError(
          "UNSUPPORTED_OPERATION",
          `OpenSuiteEngineAdapter does not support inspect focus "${focus.kind}". Use focus.kind="context" for bounded DOCX text context.`,
          { focus },
        );
      }

      if (!focus.text) {
        return inspectionError(
          "VALIDATION_FAILED",
          "inspect focus.kind=context requires non-empty text",
        );
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);
      const response = await binding.inspectDocx(inputBytes, {
        target: {
          text: focus.text,
          ...(focus.occurrence !== undefined
            ? { occurrence: focus.occurrence }
            : {}),
        },
        ...(focus.before !== undefined ? { before: focus.before } : {}),
        ...(focus.after !== undefined ? { after: focus.after } : {}),
      });

      const diagnostics = response.diagnostics.map(mapDiagnostic);
      if (!response.ok) {
        return {
          status: "error",
          diagnostics: ensureNonEmpty(
            diagnostics.map(normalizeDiagnosticCode),
            "VALIDATION_FAILED",
            "Engine inspect failed",
          ),
        };
      }

      const unitCount =
        (response.container ? 1 : 0) + response.nearby.length;
      return {
        status: "success",
        format: "docx",
        capabilities: cachedCapabilities,
        diagnostics,
        focus,
        payload: {
          format: "docx",
          summary: {
            title: null,
            unitKind: "page",
            unitCount,
          },
          context: {
            target: {
              text: response.target.text,
              ...(response.target.occurrence !== undefined
                ? { occurrence: response.target.occurrence }
                : {}),
            },
            ...(response.container
              ? {
                  container: {
                    text: response.container.text,
                    container: response.container.container,
                    relativePosition: response.container.relativePosition,
                  },
                }
              : {}),
            nearby: response.nearby.map((item) => ({
              text: item.text,
              container: item.container,
              relativePosition: item.relativePosition,
            })),
          },
        },
      };
    },

    async find(document, query, findOptions): Promise<FindResult> {
      throwIfAborted(findOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentFind)) {
        return unsupportedCapabilityFind(Capabilities.DocumentFind);
      }

      if (document.format !== "docx") {
        return findError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX find (got ${document.format})`,
          { format: document.format },
        );
      }

      const mode = query.mode ?? "text";
      if (mode === "semantic") {
        return findError(
          "UNSUPPORTED_OPERATION",
          'OpenSuiteEngineAdapter find mode "semantic" is not supported by the engine binding; use mode "text"',
          { mode },
        );
      }

      const trimmed = query.query.trim();
      if (!trimmed) {
        return findError(
          "INVALID_FIND_QUERY",
          "Find query must be a non-empty string",
        );
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);
      const response = await binding.findDocxText(inputBytes, {
        text: trimmed,
      });

      const diagnostics = response.diagnostics.map(mapDiagnostic);
      if (!response.ok) {
        return {
          status: "error",
          diagnostics: ensureNonEmpty(
            diagnostics.map(normalizeDiagnosticCode),
            "VALIDATION_FAILED",
            "Engine find failed",
          ),
        };
      }

      const maxResults = clampMaxResults(query.maxResults);
      const matches: FindMatch[] = response.matches
        .slice(0, maxResults)
        .map((match) => ({
          handle: `docx:find:${match.occurrence}`,
          excerpt: buildExcerpt(match.before, match.text, match.after),
          location: `${match.container} #${match.occurrence}`,
          score: 1,
        }));

      return {
        status: "success",
        query: trimmed,
        mode: "text",
        matches,
        diagnostics,
      };
    },

    async execute(
      document,
      operation,
      executeOptions,
    ): Promise<OperationResult> {
      throwIfAborted(executeOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentMutate)) {
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
          "UNSUPPORTED_OPERATION",
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

/**
 * Map Rust RuntimeCapabilities into agent-core RuntimeCapabilities.
 * Rust remains the source of truth — we only bridge well-known tool gates.
 */
export function mapRustCapabilitiesToRuntime(
  engine: DocxRuntimeCapabilities,
): RuntimeCapabilities {
  const docx = engine.formats.find((format) => format.format === "docx");
  const rustIds = docx?.capabilities ?? [];
  const ids: string[] = [...rustIds];

  if (rustIds.includes("find_text")) {
    ids.push(Capabilities.DocumentFind);
  }
  if (
    rustIds.includes("inspect_context") ||
    rustIds.includes("inspect")
  ) {
    ids.push(Capabilities.DocumentInspect);
  }
  if (rustIds.includes("replace_text")) {
    ids.push(Capabilities.DocumentMutate);
  }

  return createCapabilities(...ids);
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
  if (code === "INVALID_ZIP") {
    return "DOCUMENT_INVALID";
  }
  return code as OperationFailureCode;
}

function normalizeDiagnosticCode(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.code === "INVALID_ZIP") {
    return { ...diagnostic, code: "DOCUMENT_INVALID" };
  }
  return diagnostic;
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

function inspectionError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): InspectionResult {
  return {
    status: "error",
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

function findError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FindResult {
  return {
    status: "error",
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

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function buildExcerpt(before: string, text: string, after: string): string {
  const combined = `${before}${text}${after}`.trim();
  return combined.length > 160 ? `${combined.slice(0, 157)}...` : combined;
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

/** Exported for tests that need to assert focus typing stays narrow. */
export type { DocumentInspectFocus, DocumentRef };
