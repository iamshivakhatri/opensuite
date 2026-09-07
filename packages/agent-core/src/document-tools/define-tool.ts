import { AgentCoreError } from "../errors.js";
import type {
  DocumentMutationExecutor,
  DocumentMutationResult,
  PersistedDocumentMutationToolResult,
} from "../document-mutation.js";
import type {
  AgentTool,
  ToolEffect,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolInputSchema,
  ToolRisk,
} from "../model.js";
import type { DocumentRuntime, OperationResult } from "../runtime.js";
import {
  Capabilities,
  hasCapability,
  type DocumentRef,
} from "../types.js";

/**
 * Declarative document-tool descriptor.
 * Individual typed tools stay model-visible; this only removes repeated plumbing.
 */
export interface DocumentToolDefinition<TInput, TResult> {
  readonly name: string;
  readonly description: string;
  readonly risk?: ToolRisk;
  readonly effect?: ToolEffect;
  readonly executionMode?: ToolExecutionMode;
  /**
   * Runtime capability id this tool requires for discovery + execute gating.
   * Prefer the short alias `capability` when declaring descriptors.
   * (Rust/runtime remains source of truth for what the id means.)
   */
  readonly capability?: string;
  /** @deprecated Prefer `capability` — same meaning. */
  readonly requireCapability?: string;
  readonly inputSchema: ToolInputSchema;
  parseInput(raw: unknown): TInput;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TResult>;
}

export function defineDocumentTool<TInput, TResult>(
  def: DocumentToolDefinition<TInput, TResult>,
): AgentTool<TInput, TResult> {
  const requireCapability = def.capability ?? def.requireCapability;
  return {
    name: def.name,
    description: def.description,
    risk: def.risk ?? "safe",
    ...(def.effect !== undefined ? { effect: def.effect } : {}),
    ...(def.executionMode !== undefined
      ? { executionMode: def.executionMode }
      : {}),
    ...(requireCapability !== undefined ? { requireCapability } : {}),
    inputSchema: def.inputSchema,
    parseInput: def.parseInput,
    async execute(input, ctx) {
      if (requireCapability !== undefined) {
        await requireRuntimeCapability(ctx, requireCapability);
      }
      return def.execute(input, ctx);
    },
  };
}

export function requireDocumentRuntime(ctx: ToolExecutionContext): {
  document: DocumentRef;
  runtime: DocumentRuntime;
} {
  if (!ctx.primaryDocument) {
    throw new AgentCoreError(
      "TOOL_FAILURE",
      "No primary document is attached to this agent run",
      {
        diagnostic: {
          code: "PRIMARY_DOCUMENT_MISSING",
          severity: "error",
          message: "No primary document is attached to this agent run",
        },
      },
    );
  }
  if (!ctx.runtime) {
    throw new AgentCoreError(
      "RUNTIME_FAILURE",
      "DocumentRuntime is not configured for this agent",
      {
        diagnostic: {
          code: "DOCUMENT_RUNTIME_MISSING",
          severity: "error",
          message: "DocumentRuntime is not configured for this agent",
        },
      },
    );
  }
  return { document: ctx.primaryDocument, runtime: ctx.runtime };
}

export async function requireRuntimeCapability(
  ctx: ToolExecutionContext,
  capability: string,
): Promise<void> {
  const { document, runtime } = requireDocumentRuntime(ctx);
  const caps = await runtime.capabilities(document);
  if (!hasCapability(caps, capability)) {
    throw diagnosticError({
      code: "UNSUPPORTED_CAPABILITY",
      severity: "error",
      message: `Runtime does not support capability: ${capability}`,
      details: { capability },
    });
  }
}

export function requireMutations(
  ctx: ToolExecutionContext,
  toolName: string,
): DocumentMutationExecutor {
  if (!ctx.mutations) {
    throw new AgentCoreError(
      "RUNTIME_FAILURE",
      `DocumentMutationExecutor is not configured; cannot persist ${toolName}`,
      {
        diagnostic: {
          code: "DOCUMENT_MUTATIONS_MISSING",
          severity: "error",
          message: `DocumentMutationExecutor is not configured; cannot persist ${toolName}`,
        },
      },
    );
  }
  return ctx.mutations;
}

/**
 * Shared DOCX persisted-mutation path:
 * mutations executor → immutable N+1 → advance RunDocumentState → standard result.
 * Does not advance on error.
 */
export async function executePersistedMutation(
  ctx: ToolExecutionContext,
  toolName: string,
  apply: (
    document: DocumentRef,
    mutations: DocumentMutationExecutor,
  ) => Promise<DocumentMutationResult>,
): Promise<PersistedDocumentMutationToolResult> {
  const mutations = requireMutations(ctx, toolName);
  const { document } = requireDocumentRuntime(ctx);
  await requireRuntimeCapability(ctx, Capabilities.DocumentMutate);

  const result = await apply(document, mutations);
  if (result.status === "error") {
    throw diagnosticError(result.diagnostics[0]!);
  }
  ctx.advancePrimaryDocument?.(result.document);
  return {
    status: "success",
    diagnostics: result.diagnostics,
    ...(result.change !== undefined ? { change: result.change } : {}),
    document: result.document,
    ...(result.versionNumber !== undefined
      ? { versionNumber: result.versionNumber }
      : {}),
    baseVersionId: result.baseVersionId,
  };
}

/** PPTX/XLSX mock mutation path via DocumentRuntime.execute (not DocumentMutationExecutor). */
export async function executeRuntimeMutation(
  ctx: ToolExecutionContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<OperationResult> {
  const { document, runtime } = requireDocumentRuntime(ctx);
  await requireRuntimeCapability(ctx, Capabilities.DocumentMutate);
  if (!runtime.execute) {
    throw diagnosticError({
      code: "UNSUPPORTED_CAPABILITY",
      severity: "error",
      message: `Runtime does not support capability: ${Capabilities.DocumentMutate}`,
      details: { capability: Capabilities.DocumentMutate },
    });
  }
  const result = await runtime.execute(
    document,
    {
      type,
      baseVersionId: document.versionId,
      payload,
    },
    { signal: ctx.signal, runId: ctx.runId },
  );
  if (result.status === "error") {
    throw diagnosticError(result.diagnostics[0]!);
  }
  return result;
}

export function unwrapResult<T extends { status: string; diagnostics: readonly unknown[] }>(
  result: T,
): Exclude<T, { status: "error" }> {
  if (result.status === "error") {
    throw diagnosticError(
      (result.diagnostics[0] ?? {
        code: "TOOL_FAILURE",
        severity: "error",
        message: "Operation failed",
      }) as {
        code: string;
        severity: "info" | "warning" | "error";
        message: string;
        details?: Record<string, unknown>;
      },
    );
  }
  return result as Exclude<T, { status: "error" }>;
}

export function diagnosticError(diagnostic: {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}): AgentCoreError {
  const code =
    diagnostic.code === "UNSUPPORTED_CAPABILITY"
      ? "UNSUPPORTED_CAPABILITY"
      : "TOOL_FAILURE";
  return new AgentCoreError(code, diagnostic.message, { diagnostic });
}

export function assertEmptyOrObject(raw: unknown, toolName: string): void {
  if (raw === undefined || raw === null) {
    return;
  }
  assertObject(raw, toolName);
}

export function assertObject(
  raw: unknown,
  toolName: string,
): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} input must be an object`,
    );
  }
  return raw as Record<string, unknown>;
}

export function invalidInput(message: string): never {
  throw new AgentCoreError("INVALID_TOOL_INPUT", message);
}
