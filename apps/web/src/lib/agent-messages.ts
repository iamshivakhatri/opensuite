import type {
  AgentMessage,
  AgentStep,
  ChatAttachment,
  ListedDocument,
} from "./api.ts";

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
    return steps[index + 1]?.name !== "finish" && steps[index + 1]?.name !== "finish_with_input_needed" && steps[index + 1]?.name !== "request_clarification";
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
  documents: readonly Pick<ListedDocument, "id" | "name">[],
): Array<{ id: string; name: string }> {
  const byId = new Map(documents.map((document) => [document.id, document.name]));
  return (message.documentIds ?? []).map((documentId) => ({
    id: documentId,
    name: byId.get(documentId) ?? "Attached document",
  }));
}

export type MessageAttachmentChip = {
  readonly id: string;
  readonly filename: string;
  readonly typeLabel: string;
  readonly sizeBytes: number | null;
  readonly available: boolean;
  readonly isImage: boolean;
};

/** Short file-type label for chat attachment chips (PDF, DOCX, TXT, …). */
export function chatAttachmentTypeLabel(
  filename: string,
  mediaType?: string,
): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toUpperCase()
    : "";
  if (ext === "MARKDOWN") return "MD";
  if (ext === "JPEG") return "JPG";
  if (ext) return ext.slice(0, 4);
  if (mediaType?.includes("pdf")) return "PDF";
  if (mediaType?.includes("wordprocessingml")) return "DOCX";
  if (mediaType?.startsWith("image/")) return "IMG";
  if (mediaType?.startsWith("text/")) return "TXT";
  return "FILE";
}

/** Merges attachment metadata pages by id (newest/incoming wins). */
export function mergeAttachmentCatalog(
  prev: readonly ChatAttachment[],
  incoming: readonly ChatAttachment[],
): ChatAttachment[] {
  if (incoming.length === 0) return [...prev];
  const byId = new Map(prev.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * Resolves one historical message's chat attachments from persisted records.
 * Missing/deleted IDs still produce a chip so history stays honest.
 */
export function messageAttachments(
  message: AgentMessage,
  catalog: readonly Pick<
    ChatAttachment,
    "id" | "filename" | "mediaType" | "sizeBytes" | "status"
  >[],
): MessageAttachmentChip[] {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return (message.attachmentIds ?? []).map((attachmentId) => {
    const meta = byId.get(attachmentId);
    if (!meta || meta.status === "deleted") {
      return {
        id: attachmentId,
        filename: "Unavailable attachment",
        typeLabel: "FILE",
        sizeBytes: null,
        available: false,
        isImage: false,
      };
    }
    return {
      id: meta.id,
      filename: meta.filename,
      typeLabel: chatAttachmentTypeLabel(meta.filename, meta.mediaType),
      sizeBytes: meta.sizeBytes,
      available: true,
      isImage: /^image\/(png|jpeg)$/.test(meta.mediaType),
    };
  });
}
