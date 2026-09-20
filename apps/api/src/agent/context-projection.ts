export const MAX_HISTORY_MESSAGES = 40;
export const MAX_HISTORY_CHARACTERS = 32_000;
export const MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS = 12_000;

const TRUNCATION_MARKER = "\n\n[Historical message truncated for model context]";

export interface HistoricalMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface HistoricalProjection {
  readonly messages: readonly HistoricalMessage[];
  readonly historicalMessagesLoaded: number;
  readonly historicalMessagesProjected: number;
  readonly historicalCharactersLoaded: number;
  readonly historicalCharactersProjected: number;
  readonly historyWasTrimmed: boolean;
}

/**
 * Keep a deterministic recent tail for the model. Persisted history is never
 * changed; this is only the model-facing projection for one execution.
 */
export function projectHistoricalMessages(
  messages: readonly HistoricalMessage[],
): HistoricalProjection {
  const historicalCharactersLoaded = characters(messages);
  const selected: HistoricalMessage[] = [];
  let historicalCharactersProjected = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_HISTORY_MESSAGES) break;
    const message = messages[index]!;
    const content = projectContent(message.content);
    if (historicalCharactersProjected + content.length > MAX_HISTORY_CHARACTERS) {
      break;
    }
    selected.push({ role: message.role, content });
    historicalCharactersProjected += content.length;
  }

  selected.reverse();
  while (selected[0]?.role === "assistant") {
    historicalCharactersProjected -= selected.shift()!.content.length;
  }

  return {
    messages: selected,
    historicalMessagesLoaded: messages.length,
    historicalMessagesProjected: selected.length,
    historicalCharactersLoaded,
    historicalCharactersProjected,
    historyWasTrimmed:
      selected.length !== messages.length ||
      historicalCharactersProjected !== historicalCharactersLoaded,
  };
}

function projectContent(content: string): string {
  if (content.length <= MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS) return content;
  return `${content.slice(0, MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function characters(messages: readonly HistoricalMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}
