/**
 * Failure fuse: caps how many times the exact same (tool + args) call may be
 * attempted across turns. Prevents the model from burning the whole turn budget
 * re-issuing an identical call that keeps failing.
 *
 * Generic: it keys on the tool name and a stable hash of the input, nothing else.
 */
export interface FailureFuse {
  /** True when this exact call has already failed `maxAttempts` times. */
  tripped(toolName: string, input: unknown): boolean;
  /** Record one failed attempt for this exact call. */
  record(toolName: string, input: unknown): void;
}

export function createFailureFuse(maxAttempts: number): FailureFuse {
  const failures = new Map<string, number>();
  const key = (toolName: string, input: unknown): string =>
    `${toolName}\u0000${stableStringify(input)}`;

  return {
    tripped(toolName, input) {
      return (failures.get(key(toolName, input)) ?? 0) >= maxAttempts;
    },
    record(toolName, input) {
      const k = key(toolName, input);
      failures.set(k, (failures.get(k) ?? 0) + 1);
    },
  };
}

/** Deterministic JSON with sorted object keys, so equal calls hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}
