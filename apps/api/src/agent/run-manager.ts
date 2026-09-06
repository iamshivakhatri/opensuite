import type { AgentEvent, AgentEventSink } from "@opensuite/agent-core";

import type {
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
          code: event.diagnostic.code,
          // Never stream raw provider/model exception text over SSE.
          message: "Agent run failed",
        },
      };
    case "tool.started":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
      };
    case "tool.completed":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
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
          code: event.diagnostic.code,
          message: truncate(event.diagnostic.message, 200),
        },
      };
    case "confirmation.required":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          reason: event.reason,
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
          baseVersionId: event.baseVersionId,
          ...(event.versionNumber !== undefined
            ? { versionNumber: event.versionNumber }
            : {}),
        },
      };
    case "turn.started":
    case "turn.completed":
      return null;
    case "message.started":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          messageId: event.messageId,
          role: event.role,
        },
      };
    case "message.delta":
      return {
        runId: event.runId,
        type: event.type,
        at: event.at,
        data: {
          messageId: event.messageId,
          role: event.role,
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
          role: event.role,
          content: truncate(event.content, 8_000),
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
  readonly hub: EventHub;
  readonly abort: AbortController;
  readonly result: Promise<AgentExecutionResult>;
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
 * Not durable across API process restarts — GET /runs + AgentSteps recover history.
 */
export function createAgentRunManager(deps: AgentRunManagerDeps) {
  const active = new Map<string, ActiveRun>();
  const liveGraceMs = deps.liveGraceMs ?? 15_000;

  async function startRun(input: {
    userId: string;
    threadId: string;
    instruction: string;
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
      signal: abort.signal,
      liveEvents,
    });

    const entry: ActiveRun = {
      ownerUserId: input.userId,
      hub,
      abort,
      result: handle.result,
    };
    active.set(handle.run.id, entry);

    void handle.result.catch(() => undefined);
    void handle.result.finally(() => {
      const timer = setTimeout(() => {
        const current = active.get(handle.run.id);
        if (current === entry) {
          current.hub.close();
          active.delete(handle.run.id);
        }
      }, liveGraceMs);
      timer.unref?.();
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
    cancel,
    waitForRun,
    waitForIdle,
    /** Test helper */
    _activeCount: () => active.size,
  };
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
