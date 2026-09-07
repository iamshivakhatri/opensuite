/**
 * Lightweight run observability helpers (dev/runtime metrics).
 * Not a product analytics system — sizes/timings for agent-loop measurement.
 */

/** UTF-8 byte length of a JSON-serialized value (best-effort). */
export function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    try {
      return Buffer.byteLength(String(value), "utf8");
    } catch {
      return 0;
    }
  }
}

/** Sum of JSON bytes for a list of messages (model-facing context size). */
export function measureMessagesBytes(
  messages: readonly unknown[],
): number {
  return measureJsonBytes(messages);
}

/** Sum of tool catalog definition bytes. */
export function measureToolCatalogBytes(tools: readonly unknown[]): number {
  return measureJsonBytes(tools);
}

/** Byte size of tool-call argument payloads in one assistant response. */
export function measureToolArgumentBytes(
  toolCalls: readonly { readonly input?: unknown }[],
): number {
  let total = 0;
  for (const call of toolCalls) {
    total += measureJsonBytes(call.input ?? null);
  }
  return total;
}

export function elapsedMs(startedAt: number, endedAt: number = Date.now()): number {
  return Math.max(0, endedAt - startedAt);
}
