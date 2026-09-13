/**
 * TEMP: agent lifecycle diagnosis — remove after diagnosis.
 * Opt-in: AGENT_DEBUG_LIFECYCLE=1
 */

const PREFIX = "[agent-debug]";

export function isAgentDebugLifecycle(): boolean {
  return process.env.AGENT_DEBUG_LIFECYCLE === "1";
}

/** Compact one-line lifecycle log. No-op unless AGENT_DEBUG_LIFECYCLE=1. */
export function agentDebugLifecycle(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isAgentDebugLifecycle()) {
    return;
  }
  const parts: string[] = [PREFIX, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatField(value)}`);
  }
  console.log(parts.join(" "));
}

/** Observe AbortSignal without changing abort behavior. */
export function watchAbortSignal(
  signal: AbortSignal | undefined,
  source: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isAgentDebugLifecycle() || !signal) {
    return;
  }
  const startedAt = Date.now();
  if (signal.aborted) {
    agentDebugLifecycle("ABORT", {
      source,
      already: true,
      reason: abortReason(signal),
      ...fields,
    });
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      agentDebugLifecycle("ABORT", {
        source,
        reason: abortReason(signal),
        elapsedMs: Date.now() - startedAt,
        ...fields,
      });
    },
    { once: true },
  );
}

export function summarizeDebugError(error: unknown): Record<string, unknown> {
  if (error == null) {
    return { error: String(error) };
  }
  if (!(error instanceof Error)) {
    return {
      errorType: typeof error,
      message: String(error).slice(0, 300),
    };
  }
  const record = error as Error & {
    code?: unknown;
    cause?: unknown;
    status?: unknown;
  };
  const cause =
    record.cause instanceof Error
      ? {
          causeName: record.cause.name,
          causeMessage: record.cause.message.slice(0, 200),
          ...(typeof (record.cause as Error & { code?: unknown }).code !==
          "undefined"
            ? {
                causeCode: String(
                  (record.cause as Error & { code?: unknown }).code,
                ),
              }
            : {}),
        }
      : record.cause !== undefined
        ? { cause: String(record.cause).slice(0, 200) }
        : {};
  const stack = record.stack
    ?.split("\n")
    .slice(0, 4)
    .map((line) => line.trim())
    .join(" | ");
  return {
    errorName: record.name,
    errorClass: record.constructor?.name ?? "Error",
    message: record.message.slice(0, 400),
    ...(record.code !== undefined ? { code: String(record.code) } : {}),
    ...(record.status !== undefined ? { status: String(record.status) } : {}),
    abortLike: looksAbortLike(error),
    timeoutLike: /timeout|timed out|exceeded/i.test(record.message),
    ...cause,
    ...(stack ? { stack: stack.slice(0, 500) } : {}),
  };
}

function looksAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return (
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    ("code" in error && String(error.code) === "CANCELLED")
  );
}

function abortReason(signal: AbortSignal): string {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason == null) {
    return "unspecified";
  }
  if (reason instanceof Error) {
    return `${reason.name}:${reason.message.slice(0, 120)}`;
  }
  return String(reason).slice(0, 120);
}

function formatField(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value.slice(0, 200)) : value.slice(0, 200);
  }
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}
