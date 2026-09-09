import type { ConfirmationGate, ConfirmationRequest } from "@opensuite/agent-core";

/**
 * Bridges AgentRunner's in-process `ConfirmationGate.confirm()` call to an
 * async HTTP approve/deny decision from the frontend.
 *
 * AgentRunner executes confirmation-gated tools sequentially (see
 * `isParallelSafeCall` in runner.ts), so at most one confirmation is ever
 * outstanding per run — the pending map is keyed by runId alone.
 *
 * In-process only, matching AgentRunManager's existing in-memory-only run
 * tracking. Not durable across API process restarts (a restart drops the
 * pending run entirely, same as any other live run today).
 */
export interface ConfirmationBridge extends ConfirmationGate {
  /**
   * Resolve the pending confirmation for a run, exactly once.
   *
   * @returns "resolved" when a matching pending confirmation was found and
   * settled. "not_found" for any stale, duplicate, unknown, or
   * already-resolved attempt — including a `toolCallId` that no longer
   * matches the currently pending one.
   */
  resolve(input: {
    readonly runId: string;
    readonly toolCallId: string;
    readonly approve: boolean;
  }): "resolved" | "not_found";

  /** Read-only peek so routes can report pending state without guessing. */
  getPending(
    runId: string,
  ): { readonly toolCallId: string; readonly toolName: string } | null;
}

interface PendingEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly settle: (approved: boolean) => void;
}

export function createHttpConfirmationBridge(): ConfirmationBridge {
  const pending = new Map<string, PendingEntry>();

  async function confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((settlePromise) => {
      let settled = false;

      function settle(approved: boolean): void {
        if (settled) {
          return;
        }
        settled = true;
        const current = pending.get(request.runId);
        if (current && current.toolCallId === request.toolCallId) {
          pending.delete(request.runId);
        }
        signal?.removeEventListener("abort", onAbort);
        settlePromise(approved);
      }

      function onAbort(): void {
        // Runner checks `throwIfAborted(signal)` right after confirm()
        // resolves, so this only unblocks the wait — it does not fake a
        // denial; the runner turns it into a real cancellation.
        settle(false);
      }

      pending.set(request.runId, {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        settle,
      });

      if (signal) {
        if (signal.aborted) {
          settle(false);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function resolve(input: {
    readonly runId: string;
    readonly toolCallId: string;
    readonly approve: boolean;
  }): "resolved" | "not_found" {
    const entry = pending.get(input.runId);
    if (!entry || entry.toolCallId !== input.toolCallId) {
      return "not_found";
    }
    entry.settle(input.approve);
    return "resolved";
  }

  function getPending(
    runId: string,
  ): { readonly toolCallId: string; readonly toolName: string } | null {
    const entry = pending.get(runId);
    return entry
      ? { toolCallId: entry.toolCallId, toolName: entry.toolName }
      : null;
  }

  return { confirm, resolve, getPending };
}
