import { AgentCoreError, ToolPolicySkipError } from "../errors.js";
import type {
  DocumentMutationExecutor,
  DocumentMutationExecutionResult,
  DocumentMutationResult,
  DocumentPreflightMutateResult,
  PersistedDocumentMutationToolResult,
} from "../document-mutation.js";
import { FORMATTING_MUTATION_TYPES } from "../document-mutation.js";
import { requireCurrentArtifactHandles } from "../artifact-handles.js";
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
  type Diagnostic,
  type DocumentRef,
} from "../types.js";
import {
  emitProgressEvent,
  isPreflightEligibleMutation,
  isRecoveryActive,
  notePreflightRejection,
  toolCallSignature,
} from "./progress-ledger.js";

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
 * validate handles → mutations executor → immutable N+1 → advance RunDocumentState
 * → emit document.version.advanced.
 * Does not advance or emit on error. Does not call Rust when handles are stale/unknown.
 *
 * When Recovery Mode is active and the tool is preflight-eligible, routes through
 * `mutations.preflightMutate` (validate once → promote exact bytes) instead of a
 * normal durable failure for semantic rejects.
 */
export async function executePersistedMutation(
  ctx: ToolExecutionContext,
  toolName: string,
  apply: (
    document: DocumentRef,
    mutations: DocumentMutationExecutor,
  ) => Promise<DocumentMutationExecutionResult>,
  toolInput?: unknown,
): Promise<PersistedDocumentMutationToolResult> {
  const ledger = ctx.documentProgress;
  const recoveryPreflight =
    ledger !== undefined &&
    isRecoveryActive(ledger) &&
    !ledger.recovery?.exhausted &&
    isPreflightEligibleMutation(toolName) &&
    typeof ctx.mutations?.preflightMutate === "function";

  try {
    if (toolInput !== undefined) {
      requireCurrentArtifactHandles(ctx, toolInput);
    }
  } catch (error) {
    if (
      recoveryPreflight &&
      error instanceof AgentCoreError &&
      (error.code === "STALE_HANDLE" || error.code === "UNKNOWN_HANDLE")
    ) {
      throwPreflightRejection(
        ctx,
        toolName,
        toolInput,
        error.code,
        error.diagnostic ? [error.diagnostic] : undefined,
      );
    }
    throw error;
  }

  const mutations = requireMutations(ctx, toolName);
  const { document } = requireDocumentRuntime(ctx);
  await requireRuntimeCapability(ctx, Capabilities.DocumentMutate);

  let result: DocumentMutationExecutionResult;
  if (recoveryPreflight && mutations.preflightMutate) {
    emitProgressEvent(ctx.events, {
      runId: ctx.runId,
      classification: "RECOVERY_PREFLIGHT_START",
      document,
      toolName,
      recoveryClass: ledger!.recovery!.recoveryClass,
      failureCode: ledger!.recovery!.failureCode,
      ledger: ledger!,
    });
    const routed = createPreflightRoutingExecutor(
      mutations,
      mutations.preflightMutate.bind(mutations),
      ctx,
      toolName,
      toolInput,
    );
    result = await apply(document, routed);
  } else {
    result = await apply(document, mutations);
  }

  if (result.status === "pending") {
    // Internal only: the document tool-turn finalizer will replace this with
    // one durable result before transcript/SSE delivery.
    return result as unknown as PersistedDocumentMutationToolResult;
  }
  if (result.status === "error") {
    throw diagnosticError(result.diagnostics[0]!);
  }
  ctx.advancePrimaryDocument?.(result.document, isFormattingOnlyMutation(toolName));
  const recentParagraphs = recentParagraphTexts(toolName, toolInput);
  if (recentParagraphs) {
    ctx.recordRecentParagraphTargets?.(result.document, recentParagraphs);
  }
  if (recoveryPreflight && ledger) {
    emitProgressEvent(ctx.events, {
      runId: ctx.runId,
      classification: "RECOVERY_PREFLIGHT_PROMOTED",
      document: result.document,
      toolName,
      recoveryClass: ledger.recovery?.recoveryClass,
      failureCode: ledger.recovery?.failureCode,
      bytesPromoted: true,
      ledger,
    });
  }
  // Domain event: emit here so AgentRunner stays mutation-result-agnostic.
  // Order relative to runner emits: tool.started → this → tool.completed.
  await ctx.events.emit({
    type: "document.version.advanced",
    runId: ctx.runId,
    documentId: result.document.documentId,
    versionId: result.document.versionId,
    ...(result.versionNumber !== undefined
      ? { versionNumber: result.versionNumber }
      : {}),
    baseVersionId: result.baseVersionId,
    at: new Date().toISOString(),
  });
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

function throwPreflightRejection(
  ctx: ToolExecutionContext,
  toolName: string,
  toolInput: unknown,
  code: string,
  diagnostics?: readonly unknown[],
): never {
  const ledger = ctx.documentProgress;
  if (!ledger) {
    throw new ToolPolicySkipError(`Recovery preflight rejected (${code})`, {
      progress: "RECOVERY_PREFLIGHT_REJECTED",
      code,
    });
  }
  const noted = notePreflightRejection(
    ledger,
    toolCallSignature(toolName, toolInput),
    code,
    diagnostics,
  );
  emitProgressEvent(ctx.events, {
    runId: ctx.runId,
    classification: noted.exhausted
      ? "RECOVERY_EXHAUSTED"
      : "RECOVERY_PREFLIGHT_REJECTED",
    document: ctx.primaryDocument,
    toolName,
    recoveryClass: ledger.recovery?.recoveryClass,
    failureCode: code,
    exactRepeatBlocked: noted.isExactRepeat,
    ledger,
  });
  throw new ToolPolicySkipError(noted.output.message, noted.output);
}

/**
 * Routes typed mutation methods through `preflightMutate` so tools keep their
 * existing apply callbacks while validate-once/promote-once stays in the executor.
 */
function createPreflightRoutingExecutor(
  base: DocumentMutationExecutor,
  preflightMutate: (
    input: {
      readonly document: DocumentRef;
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly signal?: AbortSignal;
      readonly runId?: string;
    },
  ) => Promise<DocumentPreflightMutateResult>,
  ctx: ToolExecutionContext,
  toolName: string,
  toolInput: unknown,
): DocumentMutationExecutor {
  async function route(
    type: string,
    document: DocumentRef,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<DocumentMutationResult> {
    const result = await preflightMutate({
      document,
      type,
      payload,
      signal,
      runId,
    });
    if (result.status === "preflight_rejected") {
      throwPreflightRejection(
        ctx,
        toolName,
        toolInput,
        result.code,
        result.diagnostics,
      );
    }
    if (result.status === "error") {
      throw diagnosticError(result.diagnostics[0]!);
    }
    return result;
  }

  return {
    ...base,
    flushPendingFormatting: base.flushPendingFormatting?.bind(base),
    abandonPendingFormatting: base.abandonPendingFormatting?.bind(base),
    async mutate(input) {
      return route(input.type, input.document, input.payload, input.signal, input.runId);
    },
    async replaceText(input) {
      return route(
        "document.replace_text",
        input.document,
        {
          find: input.find,
          replace: input.replace,
          ...(input.expectedCurrentText !== undefined
            ? { expectedCurrentText: input.expectedCurrentText }
            : {}),
          ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
        },
        input.signal,
        input.runId,
      );
    },
    async insertParagraph(input) {
      return route(
        "document.insert_paragraph",
        input.document,
        { text: input.text, placement: input.placement },
        input.signal,
        input.runId,
      );
    },
    async insertParagraphs(input) {
      return route(
        "document.insert_paragraphs",
        input.document,
        { texts: input.texts, placement: input.placement },
        input.signal,
        input.runId,
      );
    },
    async deleteParagraph(input) {
      return route(
        "document.delete_paragraph",
        input.document,
        { target: input.target },
        input.signal,
        input.runId,
      );
    },
    async setParagraphStyle(input) {
      return route(
        "document.set_paragraph_style",
        input.document,
        {
          target: input.target,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        input.signal,
        input.runId,
      );
    },
    async setParagraphFormatting(input) {
      return route(
        "document.set_paragraph_formatting",
        input.document,
        {
          target: input.target,
          ...(input.alignment !== undefined ? { alignment: input.alignment } : {}),
          ...(input.spacingBeforeTwips !== undefined
            ? { spacingBeforeTwips: input.spacingBeforeTwips }
            : {}),
          ...(input.spacingAfterTwips !== undefined
            ? { spacingAfterTwips: input.spacingAfterTwips }
            : {}),
        },
        input.signal,
        input.runId,
      );
    },
    async setTextFormatting(input) {
      return route(
        "document.set_text_formatting",
        input.document,
        {
          target: input.target,
          ...(input.bold !== undefined ? { bold: input.bold } : {}),
          ...(input.italic !== undefined ? { italic: input.italic } : {}),
          ...(input.fontSizeHalfPoints !== undefined
            ? { fontSizeHalfPoints: input.fontSizeHalfPoints }
            : {}),
          ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
        },
        input.signal,
        input.runId,
      );
    },
    async setTableCellsText(input) {
      return route(
        "document.set_table_cells_text",
        input.document,
        { table: input.table, updates: input.updates },
        input.signal,
        input.runId,
      );
    },
    async insertTableRows(input) {
      return route(
        "document.insert_table_rows",
        input.document,
        { table: input.table, after: input.after, rows: input.rows },
        input.signal,
        input.runId,
      );
    },
    async insertTableColumn(input) {
      return route(
        "document.insert_table_column",
        input.document,
        {
          table: input.table,
          ...(input.afterColumnHeader !== undefined
            ? { afterColumnHeader: input.afterColumnHeader }
            : {}),
          ...(input.afterColumnHandle !== undefined
            ? { afterColumnHandle: input.afterColumnHandle }
            : {}),
          header: input.header,
          cells: input.cells,
        },
        input.signal,
        input.runId,
      );
    },
    async createTable(input) {
      return route(
        "document.create_table",
        input.document,
        { rows: input.rows, placement: input.placement },
        input.signal,
        input.runId,
      );
    },
    async deleteTable(input) {
      return route(
        "document.delete_table",
        input.document,
        { table: input.table },
        input.signal,
        input.runId,
      );
    },
    async deleteTableRow(input) {
      return route(
        "document.delete_table_row",
        input.document,
        { table: input.table, row: input.row },
        input.signal,
        input.runId,
      );
    },
    async deleteTableColumn(input) {
      return route(
        "document.delete_table_column",
        input.document,
        {
          table: input.table,
          ...(input.columnHeader !== undefined
            ? { columnHeader: input.columnHeader }
            : {}),
          ...(input.columnHandle !== undefined
            ? { columnHandle: input.columnHandle }
            : {}),
        },
        input.signal,
        input.runId,
      );
    },
    async setTableFormatting(input) {
      return route(
        "document.set_table_formatting",
        input.document,
        {
          table: input.table,
          ...(input.alignment !== undefined ? { alignment: input.alignment } : {}),
          ...(input.borders !== undefined ? { borders: input.borders } : {}),
          ...(input.cellMarginTopTwips !== undefined
            ? { cellMarginTopTwips: input.cellMarginTopTwips }
            : {}),
          ...(input.cellMarginRightTwips !== undefined
            ? { cellMarginRightTwips: input.cellMarginRightTwips }
            : {}),
          ...(input.cellMarginBottomTwips !== undefined
            ? { cellMarginBottomTwips: input.cellMarginBottomTwips }
            : {}),
          ...(input.cellMarginLeftTwips !== undefined
            ? { cellMarginLeftTwips: input.cellMarginLeftTwips }
            : {}),
        },
        input.signal,
        input.runId,
      );
    },
  };
}

function recentParagraphTexts(toolName: string, input: unknown): readonly string[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (toolName === "document.insert_paragraph" && typeof record.text === "string") return [record.text];
  if (toolName === "document.insert_paragraphs" && Array.isArray(record.texts) && record.texts.every((text) => typeof text === "string")) return record.texts as string[];
  return undefined;
}

function isFormattingOnlyMutation(toolName: string): boolean {
  return FORMATTING_MUTATION_TYPES.has(toolName);
}

/** PPTX/XLSX mock mutation path via DocumentRuntime.execute (not DocumentMutationExecutor). */
export async function executeRuntimeMutation(
  ctx: ToolExecutionContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<OperationResult> {
  requireCurrentArtifactHandles(ctx, payload);
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
      }) as Diagnostic,
    );
  }
  return result as Exclude<T, { status: "error" }>;
}

/** Preserve full structured Diagnostic on tool failures (reasonCode, etc.). */
export function diagnosticError(diagnostic: Diagnostic): AgentCoreError {
  const code =
    diagnostic.code === "UNSUPPORTED_CAPABILITY"
      ? "UNSUPPORTED_CAPABILITY"
      : diagnostic.code === "STALE_HANDLE"
        ? "STALE_HANDLE"
        : diagnostic.code === "UNKNOWN_HANDLE"
          ? "UNKNOWN_HANDLE"
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
