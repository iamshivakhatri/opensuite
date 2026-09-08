import {
  AgentRunner,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createDocumentRunState,
  createDocumentToolContext,
  listDocumentToolDescriptors,
  shapeDiagnosticForToolResult,
  type AgentEvent,
  type AgentEventSink,
  type AgentModel,
  type AgentRequest,
  type AgentResource,
  type AgentResult,
  type ConfirmationGate,
  type DocumentMutationExecutor,
  type DocumentRef,
  type DocumentRuntime,
  type RuntimeCapabilities,
  type SteeringSource,
} from "@opensuite/agent-core";

import {
  DocumentAccessError,
  type DocumentService,
} from "../documents/service.js";
import type { DocumentRuntimeResolver } from "../documents/runtime.js";
import { createAgentDocumentMutationExecutor } from "./document-mutation-executor.js";
import {
  AgentPersistenceError,
  type AgentMessage,
  type AgentPersistenceService,
  type AgentRun,
  type AgentRunStatus,
  type AgentStep,
  type AgentStepStatus,
  type AgentThread,
} from "./persistence.js";
import { createWorkspaceCreateBlankDocxTool } from "./workspace-tools.js";
import { devLog } from "../dev-log.js";

export type AgentExecutionErrorCode =
  | "THREAD_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "AGENT_EXECUTION_FAILED"
  | "AGENT_PERSISTENCE_FAILED";

export class AgentExecutionError extends Error {
  readonly code: AgentExecutionErrorCode;

  constructor(code: AgentExecutionErrorCode, message: string) {
    super(message);
    this.name = "AgentExecutionError";
    this.code = code;
  }
}

export interface AgentExecutionInput {
  readonly userId: string;
  readonly threadId: string;
  readonly instruction: string;
  /**
   * Tagged workspace documents for this run (Cursor-style @ attachments).
   * First id becomes primary; remaining become contextualResources.
   * When omitted/empty, falls back to thread.documentId (legacy document chat).
   */
  readonly documentIds?: readonly string[];
  readonly signal?: AbortSignal;
  /**
   * Optional live sink (SSE hub). Non-terminal events fan out after the
   * persistence bridge; terminal events are emitted only after durable finalize.
   */
  readonly liveEvents?: AgentEventSink;
}

export interface AgentExecutionResult {
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly assistantMessage: AgentMessage | null;
  readonly steps: readonly AgentStep[];
  readonly result: AgentResult;
}

/** Returned as soon as the user message + queued run are durable. */
export interface AgentExecutionHandle {
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  /** Settles when the in-process runner + final persistence finish. */
  readonly result: Promise<AgentExecutionResult>;
}

export interface AgentExecutionServiceDeps {
  readonly persistence: AgentPersistenceService;
  /**
   * Resolve latest DocumentRef + persist agent mutations
   * (getOwnedDocument + appendDocumentVersion).
   */
  readonly documents: Pick<
    DocumentService,
    | "getOwnedDocument"
    | "appendDocumentVersion"
    | "createBlankDocxDocument"
  >;
  readonly model: AgentModel;
  /**
   * Optional fixed tool registry (tests). When omitted, the runner discovers
   * document tools once from DocumentRuntime.capabilities(primaryDocument).
   */
  readonly tools?: ToolRegistry;
  /**
   * Fixed runtime (tests). When `resolveRuntime` is set, it wins for
   * production format-aware DOCX → engine / PPTX|XLSX → mock selection.
   */
  readonly runtime?: DocumentRuntime;
  /**
   * Per-run runtime selection. Prefer this in production so DOCX uses the
   * real engine adapter with an owner-scoped artifact loader.
   */
  readonly resolveRuntime?: DocumentRuntimeResolver;
  /**
   * Optional fixed mutation executor (tests). When omitted, DOCX runs get
   * createAgentDocumentMutationExecutor → apply* (replace/table mutations).
   */
  readonly mutations?: DocumentMutationExecutor;
  /**
   * Confirmation gate for destructive tools. Omit → agent-core denies.
   * Tests may inject AutoApproveConfirmationGate / denyAllConfirmationGate.
   * Durable wait/resume is deferred.
   */
  readonly confirmation?: ConfirmationGate;
  /** In-memory only for this milestone (e.g. InMemorySteeringQueue). */
  readonly steering?: SteeringSource;
  readonly capabilities?: RuntimeCapabilities;
  readonly maxTurns?: number;
}

/**
 * Application orchestration: durable Thread/Message/Run/Step ↔ AgentRunner.
 * `start` returns after the queued run is durable; runner continues in-process.
 * `execute` awaits the full result (tests / sync callers).
 *
 * Step sequences are assigned by an in-memory monotonic counter owned by the
 * per-run event adapter (safe for one in-process execution; not distributed).
 */
export function createAgentExecutionService(deps: AgentExecutionServiceDeps) {
  const { persistence, documents } = deps;

  async function start(
    input: AgentExecutionInput,
  ): Promise<AgentExecutionHandle> {
    const thread = await persistence.getOwnedThread({
      threadId: input.threadId,
      ownerUserId: input.userId,
    });
    if (!thread) {
      throw new AgentExecutionError("THREAD_NOT_FOUND", "Agent thread not found");
    }

    const resolved = await resolveRunDocuments(
      documents,
      thread,
      input.userId,
      input.documentIds,
    );
    const primaryDocument = resolved.primary;
    const contextualResources = resolved.contextualResources;

    let userMessage: AgentMessage;
    let run: AgentRun;
    try {
      const started = await persistence.withTransaction(async (tx) => {
        const message = await persistence.appendMessage(
          {
            threadId: thread.id,
            ownerUserId: input.userId,
            role: "user",
            content: input.instruction,
          },
          tx,
        );
        const createdRun = await persistence.createRun(
          {
            threadId: thread.id,
            ownerUserId: input.userId,
            createdByUserId: input.userId,
            triggeringMessageId: message.id,
            baseDocumentVersionId: primaryDocument?.versionId ?? null,
            status: "queued",
          },
          tx,
        );
        return { message, createdRun };
      });
      userMessage = started.message;
      run = started.createdRun;
    } catch (error) {
      throw mapStartPersistenceError(error);
    }

    const result = continueExecution({
      deps,
      persistence,
      thread,
      userMessage,
      run,
      ownerUserId: input.userId,
      instruction: enrichInstructionWithWorkingSet(
        input.instruction,
        resolved.workingSetLabels,
      ),
      primaryDocument,
      contextualResources,
      signal: input.signal,
      liveEvents: input.liveEvents,
    });
    // Detached callers (HTTP 202) must not leave unhandled rejections.
    void result.catch(() => undefined);

    return { thread, userMessage, run, result };
  }

  async function execute(
    input: AgentExecutionInput,
  ): Promise<AgentExecutionResult> {
    const handle = await start(input);
    return handle.result;
  }

  return { start, execute };
}

async function continueExecution(input: {
  deps: AgentExecutionServiceDeps;
  persistence: AgentPersistenceService;
  thread: AgentThread;
  userMessage: AgentMessage;
  run: AgentRun;
  ownerUserId: string;
  instruction: string;
  primaryDocument: DocumentRef | null;
  contextualResources: readonly AgentResource[];
  signal?: AbortSignal;
  liveEvents?: AgentEventSink;
}): Promise<AgentExecutionResult> {
  const {
    deps,
    persistence,
    thread,
    userMessage,
    run,
    ownerUserId,
    instruction,
    primaryDocument,
    contextualResources,
    signal,
    liveEvents,
  } = input;

  const priorMessages = (
    await persistence.listMessagesForThread({
      threadId: thread.id,
      ownerUserId,
    })
  )
    .filter((message) => message.id !== userMessage.id)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const request: AgentRequest = {
    instruction,
    threadId: thread.id,
    runId: run.id,
    priorMessages,
    primaryDocument,
    contextualResources,
  };

  const bridge = createRunEventBridge({
    persistence,
    ownerUserId,
    runId: run.id,
  });

  // Defer terminal live SSE until after durable finalize. Otherwise the UI can
  // receive agent.completed/failed, GET /runs while status is still active,
  // drop the SSE subscription, and stick on "Working…".
  // Stream tokens to the hub before the persistence queue so DB latency cannot
  // batch message.delta behind unrelated step writes.
  const shortRun = run.id.slice(0, 8);
  const events: AgentEventSink = liveEvents
    ? {
        async emit(event) {
          logAgentTurn(shortRun, event);
          if (
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            await bridge.emit(event);
            return;
          }
          if (
            event.type === "message.started" ||
            event.type === "message.delta" ||
            event.type === "message.completed"
          ) {
            await liveEvents.emit(event);
            await bridge.emit(event);
            return;
          }
          await bridge.emit(event);
          await liveEvents.emit(event);
        },
      }
    : {
        async emit(event) {
          logAgentTurn(shortRun, event);
          await bridge.emit(event);
        },
      };

  // Prefer DOCX engine when no primary yet so blank-create → edit works in-run.
  const runtime =
    deps.resolveRuntime?.({
      format: primaryDocument?.format ?? "docx",
      ownerUserId,
    }) ?? deps.runtime;

  const mutations =
    deps.mutations ??
    (runtime
      ? createAgentDocumentMutationExecutor({
          documents: deps.documents,
          ownerUserId,
          runtime,
        })
      : undefined);

  const workspaceTools = ToolRegistry.create([
    createWorkspaceCreateBlankDocxTool({
      workspaceId: thread.workspaceId,
      ownerUserId,
      documents: deps.documents,
    }),
  ]);

  // Fixed tools (tests) skip capability discovery; still need OpenSuite-owned
  // run state so primaryDocument / handles / mutations stay outside AgentRunner.
  const documentRun = deps.tools
    ? {
        tools: deps.tools,
        createToolContext: createDocumentToolContext({
          state: createDocumentRunState(primaryDocument),
          runtime,
          mutations,
        }),
      }
    : createDocumentAgentRunnerOptions({
        tools: workspaceTools,
        documentToolCatalog: listDocumentToolDescriptors(),
        runtime,
        mutations,
        primaryDocument,
      });

  const runner = new AgentRunner({
    model: deps.model,
    ...documentRun,
    events,
    confirmation: deps.confirmation,
    steering: deps.steering,
    capabilities: deps.capabilities,
    maxTurns: deps.maxTurns,
  });

  let agentResult: AgentResult;
  try {
    agentResult = await runner.run(request, { signal });
  } catch {
    await bestEffortFailRun(
      persistence,
      ownerUserId,
      run.id,
      "AGENT_EXECUTION_FAILED",
      "Agent runner failed unexpectedly",
    );
    await emitTerminalLive(liveEvents, {
      type: "agent.failed",
      runId: run.id,
      at: new Date().toISOString(),
      diagnostic: {
        code: "AGENT_EXECUTION_FAILED",
        severity: "error",
        message: "Agent runner failed unexpectedly",
      },
    });
    throw new AgentExecutionError(
      "AGENT_EXECUTION_FAILED",
      "Agent runner failed unexpectedly",
    );
  }

  try {
    await bridge.flush();
  } catch {
    await bestEffortFailRun(
      persistence,
      ownerUserId,
      run.id,
      "AGENT_PERSISTENCE_FAILED",
      "Failed to persist agent steps",
    );
    await emitTerminalLive(liveEvents, {
      type: "agent.failed",
      runId: run.id,
      at: new Date().toISOString(),
      diagnostic: {
        code: "AGENT_PERSISTENCE_FAILED",
        severity: "error",
        message: "Failed to persist agent steps",
      },
    });
    throw new AgentExecutionError(
      "AGENT_PERSISTENCE_FAILED",
      "Failed to persist agent steps",
    );
  }

  let assistantMessage: AgentMessage | null = null;
  let finalRun: AgentRun;

  try {
    if (agentResult.status === "completed") {
      const finalized = await finalizeCompletedRun({
        persistence,
        ownerUserId,
        threadId: thread.id,
        runId: run.id,
        summary: agentResult.summary,
      });
      assistantMessage = finalized.assistantMessage;
      finalRun = finalized.run;
      await emitTerminalLive(liveEvents, {
        type: "agent.completed",
        runId: run.id,
        at: new Date().toISOString(),
      });
    } else if (agentResult.status === "cancelled") {
      await bridge.cancelOpenSteps();
      finalRun = await persistence.updateRunStatus({
        runId: run.id,
        ownerUserId,
        status: "cancelled",
      });
      await emitTerminalLive(liveEvents, {
        type: "agent.cancelled",
        runId: run.id,
        at: new Date().toISOString(),
      });
    } else {
      const diagnostic = agentResult.diagnostics[0];
      finalRun = await persistence.updateRunStatus({
        runId: run.id,
        ownerUserId,
        status: "failed",
        errorCode: safeErrorCode(diagnostic?.code, "AGENT_EXECUTION_FAILED"),
        errorMessage: safeErrorMessage(
          diagnostic?.message ?? agentResult.summary,
          "Agent run failed",
        ),
      });
      await emitTerminalLive(liveEvents, {
        type: "agent.failed",
        runId: run.id,
        at: new Date().toISOString(),
        diagnostic: diagnostic ?? {
          code: "AGENT_EXECUTION_FAILED",
          severity: "error",
          message: "Agent run failed",
        },
      });
    }
  } catch (error) {
    if (
      error instanceof AgentPersistenceError ||
      error instanceof AgentExecutionError
    ) {
      await bestEffortFailRun(
        persistence,
        ownerUserId,
        run.id,
        "AGENT_PERSISTENCE_FAILED",
        "Failed to finalize agent run",
      );
      await emitTerminalLive(liveEvents, {
        type: "agent.failed",
        runId: run.id,
        at: new Date().toISOString(),
        diagnostic: {
          code: "AGENT_PERSISTENCE_FAILED",
          severity: "error",
          message: "Failed to finalize agent run",
        },
      });
      throw new AgentExecutionError(
        "AGENT_PERSISTENCE_FAILED",
        "Failed to finalize agent run",
      );
    }
    throw error;
  }

  const steps = await persistence.listStepsForRun({
    runId: finalRun.id,
    ownerUserId,
  });

  return {
    thread,
    userMessage,
    run: finalRun,
    assistantMessage,
    steps,
    result: agentResult,
  };
}

async function emitTerminalLive(
  liveEvents: AgentEventSink | undefined,
  event: Extract<
    AgentEvent,
    | { type: "agent.completed" }
    | { type: "agent.failed" }
    | { type: "agent.cancelled" }
  >,
): Promise<void> {
  if (!liveEvents) {
    return;
  }
  await liveEvents.emit(event);
}

/** Dev one-liners for agent turns — skip token spam (message.delta). */
function logAgentTurn(shortRun: string, event: AgentEvent): void {
  switch (event.type) {
    case "agent.started":
      devLog(`agent ${shortRun} started`);
      return;
    case "turn.started":
      devLog(`agent ${shortRun} turn ${event.turnId.slice(0, 8)}`);
      return;
    case "model.turn.metrics": {
      const tokens =
        event.inputTokens !== undefined || event.outputTokens !== undefined
          ? ` in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"}` +
            (event.cachedInputTokens !== undefined
              ? ` cached=${event.cachedInputTokens}`
              : "")
          : "";
      devLog(
        `agent ${shortRun} model turn#${event.turnIndex} ${event.modelWallMs}ms tools=${event.toolCallCount} ctx=${event.contextMessageBytes}B catalog=${event.toolCatalogBytes}B args=${event.toolArgumentBytes}B${tokens}`,
      );
      return;
    }
    case "tool.started":
      devLog(`agent ${shortRun} → ${event.toolName}`);
      return;
    case "tool.execution.metrics":
      devLog(
        `agent ${shortRun} tool ${event.toolName} ${event.wallMs}ms in=${event.inputBytes}B out=${event.resultBytes}B ${event.success ? "ok" : "fail"}`,
      );
      return;
    case "tool.completed": {
      const note = event.summary ? ` — ${event.summary}` : "";
      devLog(`agent ${shortRun} ✓ ${event.toolName}${note}`);
      return;
    }
    case "tool.failed":
      devLog(
        `agent ${shortRun} ✗ ${event.toolName} ${event.diagnostic.code}: ${event.diagnostic.message}`,
      );
      return;
    case "document.version.advanced":
      devLog(
        `agent ${shortRun} version → #${event.versionNumber ?? "?"} (${event.versionId.slice(0, 8)})`,
      );
      return;
    case "document.created":
      devLog(
        `agent ${shortRun} created ${event.name} (${event.documentId.slice(0, 8)})`,
      );
      return;
    case "agent.completed":
      devLog(`agent ${shortRun} completed`);
      return;
    case "agent.failed":
      devLog(
        `agent ${shortRun} failed ${event.diagnostic.code}: ${event.diagnostic.message}`,
      );
      return;
    case "agent.cancelled":
      devLog(`agent ${shortRun} cancelled`);
      return;
    default:
      return;
  }
}

export type AgentExecutionService = ReturnType<
  typeof createAgentExecutionService
>;

async function resolveRunDocuments(
  documents: Pick<DocumentService, "getOwnedDocument">,
  thread: AgentThread,
  ownerUserId: string,
  documentIds: readonly string[] | undefined,
): Promise<{
  primary: DocumentRef | null;
  contextualResources: readonly AgentResource[];
  workingSetLabels: readonly string[];
}> {
  const tagged = [...new Set((documentIds ?? []).filter(Boolean))];
  const ids =
    tagged.length > 0
      ? tagged
      : thread.documentId
        ? [thread.documentId]
        : [];

  if (ids.length === 0) {
    return {
      primary: null,
      contextualResources: [],
      workingSetLabels: [],
    };
  }

  const loaded: Array<{ ref: DocumentRef; name: string }> = [];
  for (const documentId of ids) {
    try {
      const document = await documents.getOwnedDocument({
        documentId,
        ownerUserId,
      });
      if (document.workspaceId !== thread.workspaceId) {
        throw new AgentExecutionError(
          "DOCUMENT_NOT_FOUND",
          "Document is not in this workspace",
        );
      }
      loaded.push({
        ref: {
          documentId: document.id,
          versionId: document.latestVersion.id,
          format: document.format,
        },
        name: document.name,
      });
    } catch (error) {
      if (
        error instanceof DocumentAccessError &&
        error.code === "DOCUMENT_NOT_FOUND"
      ) {
        throw new AgentExecutionError(
          "DOCUMENT_NOT_FOUND",
          "Document not found for agent run",
        );
      }
      throw error;
    }
  }

  const [primaryEntry, ...rest] = loaded;
  return {
    primary: primaryEntry?.ref ?? null,
    contextualResources: rest.map((entry) => ({
      kind: "document" as const,
      document: entry.ref,
      role: "context" as const,
    })),
    workingSetLabels: loaded.map((entry, index) =>
      index === 0 ? `${entry.name} (primary)` : entry.name,
    ),
  };
}

function enrichInstructionWithWorkingSet(
  instruction: string,
  labels: readonly string[],
): string {
  if (labels.length === 0) {
    return instruction;
  }
  return `Attached documents for this turn:\n${labels
    .map((label) => `- ${label}`)
    .join("\n")}\n\n${instruction}`;
}

function mapStartPersistenceError(error: unknown): AgentExecutionError {
  if (
    error instanceof AgentPersistenceError &&
    error.code === "THREAD_NOT_FOUND"
  ) {
    return new AgentExecutionError("THREAD_NOT_FOUND", "Agent thread not found");
  }
  return new AgentExecutionError(
    "AGENT_PERSISTENCE_FAILED",
    "Failed to start agent execution",
  );
}

async function finalizeCompletedRun(input: {
  persistence: AgentPersistenceService;
  ownerUserId: string;
  threadId: string;
  runId: string;
  summary: string;
}): Promise<{ run: AgentRun; assistantMessage: AgentMessage | null }> {
  const content = input.summary.trim();
  return input.persistence.withTransaction(async (tx) => {
    let assistantMessage: AgentMessage | null = null;
    if (content.length > 0) {
      assistantMessage = await input.persistence.appendMessage(
        {
          threadId: input.threadId,
          ownerUserId: input.ownerUserId,
          role: "assistant",
          content,
        },
        tx,
      );
    }

    const run = await input.persistence.updateRunStatus(
      {
        runId: input.runId,
        ownerUserId: input.ownerUserId,
        status: "completed",
      },
      tx,
    );

    return { run, assistantMessage };
  });
}

async function bestEffortFailRun(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  try {
    const existing = await persistence.getRun({ runId, ownerUserId });
    if (!existing) {
      return;
    }
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return;
    }
    await persistence.updateRunStatus({
      runId,
      ownerUserId,
      status: "failed",
      errorCode,
      errorMessage,
    });
  } catch {
    // Best-effort only — caller already has the primary error.
  }
}

function safeErrorCode(code: string | undefined, fallback: string): string {
  if (!code || code.length > 64 || /[\r\n]/.test(code)) {
    return fallback;
  }
  return code;
}

function safeErrorMessage(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return fallback;
  }
  // Avoid dumping stacks / huge internals into durable user-facing fields.
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

interface StepBinding {
  readonly stepId: string;
  readonly kind: "tool" | "confirmation";
}

/**
 * Maps selected AgentEvents → durable AgentSteps for one in-process run.
 * Serializes event handling so parallel tool emits stay race-free while tools
 * themselves may still execute concurrently after their started events land.
 */
function createRunEventBridge(input: {
  persistence: AgentPersistenceService;
  ownerUserId: string;
  runId: string;
}): AgentEventSink & {
  flush(): Promise<void>;
  cancelOpenSteps(): Promise<void>;
} {
  let nextSequence = 0;
  let runStatus: AgentRunStatus = "queued";
  const byToolCallId = new Map<string, StepBinding>();
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  async function setRunStatus(status: AgentRunStatus): Promise<void> {
    if (runStatus === status) {
      return;
    }
    if (
      runStatus === "completed" ||
      runStatus === "failed" ||
      runStatus === "cancelled"
    ) {
      return;
    }
    await input.persistence.updateRunStatus({
      runId: input.runId,
      ownerUserId: input.ownerUserId,
      status,
    });
    runStatus = status;
  }

  async function handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent.started": {
        await setRunStatus("running");
        return;
      }
      case "confirmation.required": {
        await setRunStatus("waiting_for_confirmation");
        const sequence = nextSequence;
        nextSequence += 1;
        const step = await input.persistence.appendStep({
          runId: input.runId,
          ownerUserId: input.ownerUserId,
          sequence,
          kind: "confirmation",
          name: event.toolName,
          status: "running",
          summary: event.reason,
          input: toJsonRecord(event.input),
        });
        byToolCallId.set(event.toolCallId, {
          stepId: step.id,
          kind: "confirmation",
        });
        return;
      }
      case "tool.started": {
        if (runStatus === "waiting_for_confirmation") {
          const pending = byToolCallId.get(event.toolCallId);
          if (pending?.kind === "confirmation") {
            await input.persistence.updateStepStatus({
              stepId: pending.stepId,
              ownerUserId: input.ownerUserId,
              status: "completed",
              summary: "Confirmation approved",
            });
          }
          await setRunStatus("running");
        } else {
          await setRunStatus("running");
        }

        const sequence = nextSequence;
        nextSequence += 1;
        const step = await input.persistence.appendStep({
          runId: input.runId,
          ownerUserId: input.ownerUserId,
          sequence,
          kind: "tool",
          name: event.toolName,
          status: "running",
          input: toJsonRecord(event.input),
        });
        byToolCallId.set(event.toolCallId, {
          stepId: step.id,
          kind: "tool",
        });
        return;
      }
      case "tool.completed": {
        const binding = byToolCallId.get(event.toolCallId);
        if (!binding || binding.kind !== "tool") {
          return;
        }
        await input.persistence.updateStepStatus({
          stepId: binding.stepId,
          ownerUserId: input.ownerUserId,
          status: "completed",
          summary: event.summary ?? null,
          output: toJsonRecord(event.output),
        });
        return;
      }
      case "tool.failed": {
        const binding = byToolCallId.get(event.toolCallId);
        const output = {
          ...shapeDiagnosticForToolResult(event.diagnostic),
          message: safeErrorMessage(event.diagnostic.message, "Tool failed"),
        };
        if (binding) {
          await input.persistence.updateStepStatus({
            stepId: binding.stepId,
            ownerUserId: input.ownerUserId,
            status: "failed",
            summary: event.diagnostic.message,
            output,
          });
          // Denied confirmation leaves run waiting — resume so terminal
          // transitions remain valid after the model continues.
          if (
            binding.kind === "confirmation" &&
            runStatus === "waiting_for_confirmation"
          ) {
            await setRunStatus("running");
          }
          return;
        }
        // Unknown tool / invalid input failed before tool.started.
        const sequence = nextSequence;
        nextSequence += 1;
        await input.persistence.appendStep({
          runId: input.runId,
          ownerUserId: input.ownerUserId,
          sequence,
          kind: "tool",
          name: event.toolName,
          status: "failed",
          summary: event.diagnostic.message,
          output,
        });
        return;
      }
      case "document.version.advanced":
        // Version advance is also captured on tool.completed output
        // (baseVersionId / resulting document). No separate step row.
        return;
      case "document.created":
        return;
      case "agent.cancelled":
      case "agent.completed":
      case "agent.failed":
      case "turn.started":
      case "turn.completed":
      case "message.started":
      case "message.delta":
      case "message.completed":
      case "model.turn.metrics":
      case "tool.execution.metrics":
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  return {
    emit(event: AgentEvent): Promise<void> {
      return enqueue(() => handle(event));
    },
    async flush(): Promise<void> {
      await queue;
    },
    async cancelOpenSteps(): Promise<void> {
      await queue;
      const steps = await input.persistence.listStepsForRun({
        runId: input.runId,
        ownerUserId: input.ownerUserId,
      });
      for (const step of steps) {
        if (step.status === "pending" || step.status === "running") {
          await input.persistence.updateStepStatus({
            stepId: step.id,
            ownerUserId: input.ownerUserId,
            status: "cancelled" satisfies AgentStepStatus,
          });
        }
      }
    },
  };
}
