import type { Diagnostic, DocumentRef } from "./types.js";

/**
 * Runtime conversation turn. Provider-neutral; not 1:1 with persisted
 * `agent_message` rows (DB stores only user-visible user/assistant text).
 */
export type AgentMessageRole = "user" | "assistant";

export interface AgentMessage {
  readonly role: AgentMessageRole;
  readonly content: string;
}

/**
 * Future contextual resource (extra docs, attachments). Present so contracts
 * do not assume a single-document forever world — multi-doc behavior is deferred.
 */
export interface AgentResource {
  readonly kind: "document";
  readonly document: DocumentRef;
  readonly role?: "context" | "attachment";
}

/**
 * Application-neutral start payload for an agent run.
 * No Fastify/DB/React/storage objects.
 */
export interface AgentRequest {
  readonly instruction: string;
  readonly threadId: string;
  readonly runId: string;
  /**
   * Prior user-visible turns (user|assistant) excluding the current
   * `instruction`. Application layer loads these from durable messages.
   */
  readonly priorMessages?: readonly AgentMessage[];
  /** Primary/open document. Null for workspace-level intents later. */
  readonly primaryDocument?: DocumentRef | null;
  /** Reserved for multi-doc / attachments; unused by the first runner. */
  readonly contextualResources?: readonly AgentResource[];
  readonly metadata?: {
    readonly correlationId?: string;
  };
}

/**
 * Mid-run user correction / follow-up (Pi-style steering).
 * Queue/scheduling is deferred — type exists so contracts stay open.
 */
export interface SteeringMessage {
  readonly content: string;
  readonly createdAt?: string;
}

/**
 * Outcome of one tool invocation within a run. Mixed succeeded/failed entries
 * express partial success — failures do not erase earlier successes.
 */
export interface ToolOutcome {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status:
    | "succeeded"
    | "failed"
    | "skipped"
    | "awaiting_confirmation";
  readonly summary?: string;
  /** Structured tool output when status is succeeded (not persisted by agent-core). */
  readonly output?: unknown;
  readonly diagnostic?: Diagnostic;
}

export type AgentResultStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_confirmation";

/**
 * Structured result of a core run. Does not persist document versions —
 * that remains an application concern.
 */
export interface AgentResult {
  readonly status: AgentResultStatus;
  /** Concise user-facing summary (not hidden chain-of-thought). */
  readonly summary: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly toolOutcomes: readonly ToolOutcome[];
}
