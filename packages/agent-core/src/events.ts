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
      /** Incremental assistant text from a streaming model turn. */
      readonly type: "message.delta";
      readonly runId: string;
      readonly messageId: string;
      readonly role: AgentMessageRole;
      readonly delta: string;
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
      /** Validated tool input when available (application-owned, not provider raw). */
      readonly input?: unknown;
      readonly at: string;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly summary?: string;
      /** Structured tool output when available (application-owned). */
      readonly output?: unknown;
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
      /** Validated tool input pending confirmation. */
      readonly input?: unknown;
      readonly at: string;
    }
  | {
      /**
       * Application-owned: agent mutation persisted immutable version N+1.
       * UI should refresh document metadata / reload the editor — not patch bytes.
       */
      readonly type: "document.version.advanced";
      readonly runId: string;
      readonly documentId: string;
      readonly versionId: string;
      readonly versionNumber?: number;
      readonly baseVersionId: string;
      readonly at: string;
    }
  | {
      /**
       * Application-owned: a new document was created in the workspace
       * (e.g. blank DOCX). UI may open it / refresh the explorer.
       */
      readonly type: "document.created";
      readonly runId: string;
      readonly documentId: string;
      readonly versionId: string;
      readonly name: string;
      readonly format: string;
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
    }
  | {
      /** Dev/runtime model-turn metrics — not product analytics. */
      readonly type: "model.turn.metrics";
      readonly runId: string;
      readonly turnId: string;
      readonly turnIndex: number;
      readonly at: string;
      readonly provider?: string;
      readonly modelId?: string;
      readonly modelWallMs: number;
      readonly timeToFirstTokenMs?: number;
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly outputTokens?: number;
      readonly reasoningTokens?: number;
      readonly toolCallCount: number;
      readonly toolArgumentBytes: number;
      readonly contextMessageBytes: number;
      readonly toolCatalogBytes: number;
      readonly finishReason?: string;
    }
  | {
      /** Dev/runtime tool-execution metrics — not product analytics. */
      readonly type: "tool.execution.metrics";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly at: string;
      readonly wallMs: number;
      readonly inputBytes: number;
      readonly resultBytes: number;
      readonly success: boolean;
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
