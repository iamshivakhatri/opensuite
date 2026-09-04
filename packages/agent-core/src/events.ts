import type { AgentMessageRole } from "./request.js";
import type { Diagnostic } from "./types.js";

/**
 * Discriminated agent lifecycle events.
 * Application layer later maps selected events → AgentStep persistence / SSE.
 * Never carry hidden chain-of-thought.
 */
export type AgentEvent =
  | {
      readonly type: "agent.started";
      readonly runId: string;
      readonly at: string;
    }
  | {
      readonly type: "turn.started";
      readonly runId: string;
      readonly turnId: string;
      readonly at: string;
    }
  | {
      readonly type: "turn.completed";
      readonly runId: string;
      readonly turnId: string;
      readonly at: string;
    }
  | {
      readonly type: "message.started";
      readonly runId: string;
      readonly messageId: string;
      readonly role: AgentMessageRole;
      readonly at: string;
    }
  | {
      readonly type: "message.completed";
      readonly runId: string;
      readonly messageId: string;
      readonly role: AgentMessageRole;
      readonly content: string;
      readonly at: string;
    }
  | {
      readonly type: "tool.started";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly at: string;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly summary?: string;
      readonly at: string;
    }
  | {
      readonly type: "tool.failed";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly diagnostic: Diagnostic;
      readonly at: string;
    }
  | {
      readonly type: "confirmation.required";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "agent.completed";
      readonly runId: string;
      readonly at: string;
    }
  | {
      readonly type: "agent.failed";
      readonly runId: string;
      readonly diagnostic: Diagnostic;
      readonly at: string;
    }
  | {
      readonly type: "agent.cancelled";
      readonly runId: string;
      readonly at: string;
    };

/**
 * Sink for agent events. Implementations live in the application layer
 * (persist steps, SSE, logging) — agent-core does not know about them.
 */
export interface AgentEventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

/** No-op sink for tests and dry runs. */
export const noopEventSink: AgentEventSink = {
  emit() {},
};

/** Collecting sink for deterministic tests. */
export function createRecordingEventSink(): AgentEventSink & {
  readonly events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}
