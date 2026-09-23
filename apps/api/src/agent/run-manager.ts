import type {
  AgentEvent,
  AgentEventSink,
  AgentExecutionResult,
  AgentExecutionService,
} from "./execution.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentRun,
} from "./persistence.js";

/** Application-owned live event for SSE — no CoT / provider / huge payloads. */
export interface LiveAgentEvent {
  readonly id: number;
  readonly runId: string;
  readonly type: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
}

export type LiveEventListener = (event: LiveEvent) => void;

export type LiveEvent =
  | LiveAgentEvent
  | {
      readonly id: number;
      readonly runId: string;
      readonly type: "heartbeat";
      readonly at: string;
      readonly data: Record<string, unknown>;
    };

interface EventHub {
  publishFromAgent(event: AgentEvent): void;
  subscribe(listener: LiveEventListener): () => void;
  close(): void;
  readonly closed: boolean;
}

function createEventHub(): EventHub {
  let nextId = 0;
  let closed = false;
  const buffer: LiveEvent[] = [];
  const listeners = new Set<LiveEventListener>();

  function publish(event: Omit<LiveEvent, "id">): void {
    if (closed) {
      return;
    }
    const full = { ...event, id: nextId } as LiveEvent;
    nextId += 1;
    buffer.push(full);
    for (const listener of listeners) {
      listener(full);
    }
  }

  return {
    get closed() {
      return closed;
    },
    publishFromAgent(event: AgentEvent) {
      const live = toLiveAgentEvent(event);
      if (live) {
        publish(live);
      }
    },
    subscribe(listener) {
      for (const event of buffer) {
        listener(event);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

function toLiveAgentEvent(
  event: AgentEvent,
): Omit<LiveAgentEvent, "id"> | null {
  switch (event.type) {
    case "agent.started":
    case "agent.completed":
    case "agent.cancelled":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {},
      };
    case "agent.failed":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          code: event.code,
          // Never stream raw provider/model exception text over SSE.
          message: "Agent run failed",
        },
      };
    case "message.delta":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          messageId: event.messageId,
          delta: truncate(event.delta, 2_000),
        },
      };
    case "message.completed":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          messageId: event.messageId,
          content: truncate(event.content, 8_000),
        },
      };
    case "tool.started":
    case "tool.completed":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
      };
    case "tool.failed":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          error: truncate(event.error, 500),
        },
      };
    case "document.version.advanced":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          documentId: event.documentId,
          versionId: event.versionId,
          versionNumber: event.versionNumber,
        },
      };
    case "document.created":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          documentId: event.documentId,
          versionId: event.versionId,
          versionNumber: event.versionNumber,
          name: event.name,
          kind: event.kind,
        },
      };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

/** Cap payload size without trimming — deltas often start/end with spaces/newlines. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

interface ActiveRun {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly hub: EventHub;
  readonly abort: AbortController;
  readonly result: Promise<AgentExecutionResult>;
}

export interface LiveOwnerRun {
  readonly runId: string;
  readonly threadId: string;
}

export interface AgentRunManagerDeps {
  readonly execution: AgentExecutionService;
  readonly persistence: AgentPersistenceService;
  /** How long to keep the live hub after terminal for late SSE subscribers. */
  readonly liveGraceMs?: number;
}

export interface StartedLiveRun {
  readonly run: AgentRun;
  readonly userMessage: AgentMessage;
  readonly result: Promise<AgentExecutionResult>;
}

/**
 * In-process live run tracker + SSE event hub.
 * Not durable across API process restarts — GET /runs recovers status.
 */
export function createAgentRunManager(deps: AgentRunManagerDeps) {
  const active = new Map<string, ActiveRun>();
  const liveGraceMs = deps.liveGraceMs ?? 15_000;

  async function startRun(input: {
    userId: string;
    threadId: string;
    instruction: string;
    activeDocumentId?: string;
    documentIds?: readonly string[];
    continueFromRunId?: string;
  }): Promise<StartedLiveRun> {
    const abort = new AbortController();
    const hub = createEventHub();

    const liveEvents: AgentEventSink = {
      emit(event) {
        hub.publishFromAgent(event);
      },
    };

    const handle = await deps.execution.start({
      userId: input.userId,
      threadId: input.threadId,
      instruction: input.instruction,
      ...(input.activeDocumentId !== undefined
        ? { activeDocumentId: input.activeDocumentId }
        : {}),
      ...(input.continueFromRunId !== undefined
        ? { continueFromRunId: input.continueFromRunId }
        : {}),
      ...(input.documentIds !== undefined
        ? { documentIds: input.documentIds }
        : {}),
      signal: abort.signal,
      liveEvents,
    });

    const entry: ActiveRun = {
      ownerUserId: input.userId,
      threadId: handle.run.threadId,
      hub,
      abort,
      result: handle.result,
    };
    active.set(handle.run.id, entry);

    // ONE ownership boundary for the background run promise.
    // Important: Promise.finally returns a *new* promise that re-rejects when
    // the source rejects. Leaving that derived promise unobserved terminates
    // Node (unhandledRejection → throw). Chain .catch on the finally result.
    // Final safety net: any escaped rejection must terminalize the durable run
    // and emit agent.failed so the UI cannot stay in Thinking forever.
    void handle.result
      .finally(() => {
        const timer = setTimeout(() => {
          const current = active.get(handle.run.id);
          if (current === entry) {
            current.hub.close();
            active.delete(handle.run.id);
          }
        }, liveGraceMs);
        timer.unref?.();
      })
      .catch((error) => {
        void terminalizeEscapedBackgroundFailure({
          persistence: deps.persistence,
          runId: handle.run.id,
          ownerUserId: input.userId,
          hub: entry.hub,
          aborted: entry.abort.signal.aborted,
          error,
        });
      });

    return {
      run: handle.run,
      userMessage: handle.userMessage,
      result: handle.result,
    };
  }

  function subscribeEvents(input: {
    runId: string;
    ownerUserId: string;
    onEvent: LiveEventListener;
  }):
    | { status: "ok"; unsubscribe: () => void }
    | { status: "not_found" }
    | { status: "not_live" } {
    const entry = active.get(input.runId);
    if (!entry) {
      return { status: "not_live" };
    }
    if (entry.ownerUserId !== input.ownerUserId) {
      return { status: "not_found" };
    }
    const unsub = entry.hub.subscribe(input.onEvent);
    return { status: "ok", unsubscribe: unsub };
  }

  function isLive(runId: string): boolean {
    return active.has(runId);
  }

  function hasLiveForOwner(ownerUserId: string): boolean {
    for (const entry of active.values()) {
      if (entry.ownerUserId === ownerUserId) {
        return true;
      }
    }
    return false;
  }

  function getLiveForOwner(ownerUserId: string): LiveOwnerRun | null {
    for (const [runId, entry] of active) {
      if (entry.ownerUserId === ownerUserId) {
        return { runId, threadId: entry.threadId };
      }
    }
    return null;
  }

  /**
   * Abort an in-process run. Returns false when the run is not live for this
   * owner (already finished / never tracked / wrong owner). Aborting twice is
   * safe — signal stays aborted.
   */
  function cancel(input: { runId: string; ownerUserId: string }): boolean {
    const entry = active.get(input.runId);
    if (!entry || entry.ownerUserId !== input.ownerUserId) {
      return false;
    }
    if (!entry.abort.signal.aborted) {
      entry.abort.abort();
    }
    return true;
  }

  /** Await a live run's result if still tracked; otherwise resolve immediately. */
  async function waitForRun(runId: string): Promise<void> {
    const entry = active.get(runId);
    if (!entry) {
      return;
    }
    await entry.result.catch(() => undefined);
  }

  async function waitForIdle(): Promise<void> {
    const pending = [...active.values()].map((entry) =>
      entry.result.catch(() => undefined),
    );
    await Promise.all(pending);
  }

  return {
    startRun,
    subscribeEvents,
    isLive,
    hasLiveForOwner,
    getLiveForOwner,
    cancel,
    waitForRun,
    waitForIdle,
    /** Test helper */
    _activeCount: () => active.size,
  };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Final safety net when the background execution promise rejects without
 * settling through normal runExecution catch paths. Marks the durable run
 * failed (or cancelled if already aborted) and emits a terminal SSE event.
 * Idempotent if the run is already terminal.
 */
async function terminalizeEscapedBackgroundFailure(input: {
  readonly persistence: AgentPersistenceService;
  readonly runId: string;
  readonly ownerUserId: string;
  readonly hub: EventHub;
  readonly aborted: boolean;
  readonly error: unknown;
}): Promise<void> {
  const runShort = input.runId.slice(0, 8);
  const reason =
    input.error instanceof Error
      ? `${input.error.name}: ${input.error.message}`.slice(0, 240)
      : String(input.error).slice(0, 240);
  console.error(`[agent] run=${runShort} background_unhandled reason=${reason}`);

  try {
    const current = await input.persistence.getRun({
      runId: input.runId,
      ownerUserId: input.ownerUserId,
    });
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return;
    }

    const status = input.aborted ? "cancelled" : "failed";
    await input.persistence.updateRunStatus({
      runId: input.runId,
      ownerUserId: input.ownerUserId,
      status,
      ...(status === "failed"
        ? {
            errorCode: "AGENT_EXECUTION_FAILED",
            errorMessage: "Agent execution failed",
          }
        : {}),
    });

    input.hub.publishFromAgent(
      status === "cancelled"
        ? {
            type: "agent.cancelled",
            runId: input.runId,
            at: new Date().toISOString(),
          }
        : {
            type: "agent.failed",
            runId: input.runId,
            at: new Date().toISOString(),
            code: "AGENT_EXECUTION_FAILED",
          },
    );
  } catch (finalizeError) {
    const detail =
      finalizeError instanceof Error
        ? `${finalizeError.name}: ${finalizeError.message}`.slice(0, 240)
        : String(finalizeError).slice(0, 240);
    console.error(
      `[agent] run=${runShort} background_terminalize_failed reason=${detail}`,
    );
  }
}

export type AgentRunManager = ReturnType<typeof createAgentRunManager>;

export function formatSseEvent(event: LiveEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    runId: event.runId,
    type: event.type,
    at: event.at,
    data: event.data,
  })}\n\n`;
}

export function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
