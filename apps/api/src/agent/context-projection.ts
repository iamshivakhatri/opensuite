export const MAX_HISTORY_MESSAGES = 40;
export const MAX_HISTORY_CHARACTERS = 32_000;
export const MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS = 12_000;
export const ESTIMATED_CHARACTERS_PER_TOKEN = 3;

/**
 * Conservative turn reserves when catalog max_completion is missing or huge.
 * Live OpenRouter models can advertise ~full-window max_completion; we never
 * reserve more than MAX_OUTPUT_RESERVE_TOKENS for one completion.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;
export const MAX_OUTPUT_RESERVE_TOKENS = 16_384;
export const DEFAULT_CONTINUATION_RESERVE_TOKENS = 4_096;
export const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;

/** @deprecated Prefer explicit reserves via safeInputTokenBudget; kept for callers. */
export const SAFE_INPUT_FRACTION = 0.6;

const TRUNCATION_MARKER = "\n\n[Historical message truncated for model context]";
const TOKEN_TRUNCATION_MARKER = "\n\n[Context truncated for model input]";

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
  readonly estimatedHistoricalTokens: number;
  readonly historyWasTrimmed: boolean;
  readonly historyTrimmedByTokenBudget: boolean;
}

export interface HistoricalProjectionOptions {
  /** Approximate token room after required first-turn context is reserved. */
  readonly maxTokens?: number;
}

export interface InputBudgetBreakdown {
  readonly contextLength: number;
  readonly outputReserve: number;
  readonly continuationReserve: number;
  readonly safetyMargin: number;
  readonly safeInputBudget: number;
  readonly usedOutputReserveFallback: boolean;
}

/** Conservative shared estimate; it deliberately does not claim tokenizer accuracy. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / ESTIMATED_CHARACTERS_PER_TOKEN);
}

/**
 * Model-aware output headroom for one completion.
 * Caps absurd catalog max_completion values (e.g. ~full context window).
 */
export function resolveOutputReserve(input: {
  readonly contextLength: number;
  readonly maxOutputTokens?: number;
}): { readonly outputReserve: number; readonly usedFallback: boolean } {
  const quarter = Math.max(1, Math.floor(input.contextLength * 0.25));
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens > 0) {
    return {
      outputReserve: Math.min(
        input.maxOutputTokens,
        MAX_OUTPUT_RESERVE_TOKENS,
        quarter,
      ),
      usedFallback: false,
    };
  }
  return {
    outputReserve: Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, quarter),
    usedFallback: true,
  };
}

/**
 * Usable projected-input budget before optional evidence:
 * contextWindow − outputReserve − continuationReserve − safetyMargin.
 */
export function computeInputBudget(input: {
  readonly contextLength: number;
  readonly maxOutputTokens?: number;
}): InputBudgetBreakdown {
  const { outputReserve, usedFallback } = resolveOutputReserve(input);
  const continuationReserve = Math.min(
    DEFAULT_CONTINUATION_RESERVE_TOKENS,
    Math.max(0, Math.floor(input.contextLength * 0.1)),
  );
  const safetyMargin = Math.min(
    DEFAULT_SAFETY_MARGIN_TOKENS,
    Math.max(0, Math.floor(input.contextLength * 0.05)),
  );
  return {
    contextLength: input.contextLength,
    outputReserve,
    continuationReserve,
    safetyMargin,
    safeInputBudget: Math.max(
      0,
      input.contextLength - outputReserve - continuationReserve - safetyMargin,
    ),
    usedOutputReserveFallback: usedFallback,
  };
}

export function safeInputTokenBudget(
  contextLength: number,
  maxOutputTokens?: number,
): number {
  return computeInputBudget({ contextLength, maxOutputTokens }).safeInputBudget;
}

/** Token room for optional document evidence after required model input. */
export function availableEvidenceTokenBudget(
  contextLength: number | undefined,
  reservedTokens: number,
  maxOutputTokens?: number,
): number | undefined {
  return contextLength === undefined
    ? undefined
    : Math.max(
        0,
        safeInputTokenBudget(contextLength, maxOutputTokens) - reservedTokens,
      );
}

/** Keep a prefix for compaction so its boundary only covers represented messages. */
export function projectCompactionPrefix(
  messages: readonly HistoricalMessage[],
  maxTokens: number,
): readonly HistoricalMessage[] {
  const selected: HistoricalMessage[] = [];
  let usedTokens = 0;
  for (const message of messages) {
    const content = projectContent(message.content);
    const remaining = maxTokens - usedTokens;
    if (remaining <= 0) break;
    const projected = estimateTokens(content) <= remaining
      ? content
      : truncateToTokenBudget(content, remaining);
    if (!projected) break;
    selected.push({ role: message.role, content: projected });
    usedTokens += estimateTokens(projected);
    if (projected !== content) break;
  }
  return selected;
}

/** Bound API-owned checkpoint text for model input only; persistence is unchanged. */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const maxCharacters = maxTokens * ESTIMATED_CHARACTERS_PER_TOKEN;
  if (maxCharacters <= TOKEN_TRUNCATION_MARKER.length) {
    return TOKEN_TRUNCATION_MARKER.slice(0, maxCharacters);
  }
  return `${text.slice(0, maxCharacters - TOKEN_TRUNCATION_MARKER.length)}${TOKEN_TRUNCATION_MARKER}`;
}

/**
 * Keep a deterministic recent tail for the model. Persisted history is never
 * changed; this is only the model-facing projection for one execution.
 */
export function projectHistoricalMessages(
  messages: readonly HistoricalMessage[],
  options: HistoricalProjectionOptions = {},
): HistoricalProjection {
  const historicalCharactersLoaded = characters(messages);
  const selected: HistoricalMessage[] = [];
  let historicalCharactersProjected = 0;
  let estimatedHistoricalTokens = 0;
  let historyTrimmedByTokenBudget = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_HISTORY_MESSAGES) break;
    const message = messages[index]!;
    const content = projectContent(message.content);
    if (historicalCharactersProjected + content.length > MAX_HISTORY_CHARACTERS) {
      break;
    }
    const tokens = estimateTokens(content);
    if (options.maxTokens !== undefined && estimatedHistoricalTokens + tokens > options.maxTokens) {
      historyTrimmedByTokenBudget = true;
      break;
    }
    selected.push({ role: message.role, content });
    historicalCharactersProjected += content.length;
    estimatedHistoricalTokens += tokens;
  }

  selected.reverse();
  while (selected[0]?.role === "assistant") {
    historicalCharactersProjected -= selected.shift()!.content.length;
    estimatedHistoricalTokens = selected.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
  }

  return {
    messages: selected,
    historicalMessagesLoaded: messages.length,
    historicalMessagesProjected: selected.length,
    historicalCharactersLoaded,
    historicalCharactersProjected,
    estimatedHistoricalTokens,
    historyWasTrimmed:
      selected.length !== messages.length ||
      historicalCharactersProjected !== historicalCharactersLoaded,
    historyTrimmedByTokenBudget,
  };
}

function projectContent(content: string): string {
  if (content.length <= MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS) return content;
  return `${content.slice(0, MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function characters(messages: readonly HistoricalMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}
