import type { AgentMessage, AgentStep, ListedDocument } from "@/lib/api";

/**
 * Pure message-list merge helpers for the Agent Panel's paginated transcript
 * (Context Lifecycle C6). Kept separate from the React component so the
 * dedupe/ordering semantics are directly unit-testable without a DOM.
 */

/**
 * Durable run steps shown beside an assistant message.
 *
 * Final answer text lives on `agent_message`. Narration flushed only because
 * `finish` started is identified by step order (narration immediately before a
 * finish tool step) and omitted when that message content is also rendered.
 */
export function presentationStepsForAssistantMessage(
  steps: readonly AgentStep[],
  hasAssistantContent: boolean,
): readonly AgentStep[] {
  if (!hasAssistantContent) return steps;
  return steps.filter((step, index) => {
    if (step.kind !== "narration") return true;
    return steps[index + 1]?.name !== "finish";
  });
}

/** Clear live SSE transcript once the durable assistant answer (or terminal run) is present. */
export function shouldClearLiveTranscript(options: {
  readonly hasAssistantContent: boolean;
  readonly runIsTerminal: boolean;
}): boolean {
  return options.hasAssistantContent || options.runIsTerminal;
}

function compareMessagesChronologically(a: AgentMessage, b: AgentMessage): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

/**
 * Merges a fetched (latest) message page into the current transcript by id.
 * Drops stale optimistic (`local-*`) entries once the durable page arrives,
 * and preserves any older pages already loaded via "load earlier messages".
 */
export function mergeMessagePage(
  prev: readonly AgentMessage[],
  incoming: readonly AgentMessage[],
): AgentMessage[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const kept = prev.filter(
    (message) => !incomingIds.has(message.id) && !message.id.startsWith("local-"),
  );
  return [...kept, ...incoming].sort(compareMessagesChronologically);
}

/** Prepends an older (already chronological) page ahead of the transcript, deduping by id. */
export function prependOlderMessages(
  prev: readonly AgentMessage[],
  older: readonly AgentMessage[],
): AgentMessage[] {
  const existingIds = new Set(prev.map((message) => message.id));
  const unique = older.filter((message) => !existingIds.has(message.id));
  return [...unique, ...prev];
}

/** Resolves one historical message's submitted document references. */
export function messageTaggedDocuments(
  message: AgentMessage,
  documents: readonly ListedDocument[],
): ListedDocument[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  return (message.documentIds ?? []).flatMap((documentId) => {
    const document = byId.get(documentId);
    return document ? [document] : [];
  });
}
