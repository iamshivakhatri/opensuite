/**
 * Local-dev friendly one-line logs. Avoids pino's level/time/pid/hostname/reqId noise.
 * Silent in tests. Structured logger still used for non-TTY / production via callers.
 */
export function isDevConsole(): boolean {
  return process.stdout.isTTY === true && process.env.NODE_ENV !== "test";
}

export function devLog(message: string): void {
  if (!isDevConsole()) return;
  console.log(message);
}

/** Path only — drop query strings that clutter agent/chat loops. */
export function requestPath(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Routine agent-panel polling GETs drown run logs. Keep writes, errors, and
 * unusual reads visible.
 */
export function shouldLogHttpRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
}): boolean {
  if (input.statusCode >= 400) return true;
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return true;

  const path = input.path;
  if (/^\/api\/agent\/runs\/[^/]+\/(events|working-document)$/.test(path)) {
    return false;
  }
  if (/^\/api\/agent\/threads\/[^/]+\/messages$/.test(path)) return false;
  if (/^\/api\/agent\/runs\/[^/]+$/.test(path)) return false;
  return true;
}
