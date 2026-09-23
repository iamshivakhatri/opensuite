import type { AgentMessage, ListedDocument } from "@/lib/api";

/**
 * Pure message-list merge helpers for the Agent Panel's paginated transcript
 * (Context Lifecycle C6). Kept separate from the React component so the
 * dedupe/ordering semantics are directly unit-testable without a DOM.
 */

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
