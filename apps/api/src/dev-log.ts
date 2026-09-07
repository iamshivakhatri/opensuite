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
