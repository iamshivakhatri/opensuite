import type { StopReason } from "@opensuite/agent-core-v3";

import type {
  AgentEventSink,
  AgentExecutionResult,
} from "./execution.js";
import {
  summarizeError,
  type TranscriptEntry,
} from "./run-events.js";
import type {
  AgentMessage,
  AgentPersistenceService,
  AgentRun,
  AgentThread,
} from "./persistence.js";
import {
  AGENT_EXECUTION_LEASE_RENEW_MS,
  type AgentExecutionLease,
  type AgentExecutionLeaseService,
} from "./execution-lease.js";

export const MAX_MODEL_TURNS = 20;

export async function persistTranscript(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  entries: readonly TranscriptEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await persistence.appendSteps({
      runId,
      ownerUserId,
      steps: entries.map((entry, sequence) => ({ ...entry, sequence })),
    });
  } catch (error) {
    console.error(`[agent] run=${runId.slice(0, 8)} transcript_persist_failed reason=${summarizeError(error)}`);
  }
}

export function failureCodeForStopReason(stopReason: StopReason): string {
  if (stopReason === "max_turns") return "AGENT_MAX_TURNS";
  if (stopReason === "deadline") return "AGENT_DEADLINE";
  if (stopReason === "output_limit") return "AGENT_OUTPUT_LIMIT";
  return "AGENT_EXECUTION_FAILED";
}

export function boundedStopMessage(
  stopReason: StopReason,
  hasVersionAdvance: boolean,
): string {
  const stopped = stopReason === "max_turns"
    ? `Reached the ${MAX_MODEL_TURNS} AI-turn limit before completing the task.`
    : stopReason === "output_limit"
      ? "The AI response reached its output limit before completing the task."
    : "Stopped before the task could be completed.";
  return hasVersionAdvance ? `${stopped} Changes made so far were preserved.` : stopped;
}

export async function finalizeCompletedRun(input: {
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly content: string;
  readonly inputNeeded?: boolean;
}): Promise<{ run: AgentRun; assistantMessage: AgentMessage | null }> {
  return input.persistence.withTransaction(async (tx) => {
    const content = input.content.trim();
    const assistantMessage = content
      ? await input.persistence.appendMessage({ threadId: input.threadId, ownerUserId: input.ownerUserId, role: "assistant", content }, tx)
      : null;
    const run = await input.persistence.updateRunStatus(
      {
        runId: input.runId,
        ownerUserId: input.ownerUserId,
        status: input.inputNeeded ? "completed_with_input_needed" : "completed",
        resultMessageId: assistantMessage?.id ?? null,
      },
      tx,
    );
    return { run, assistantMessage };
  });
}

export async function settleTerminalRunFailure(input: {
  readonly error?: unknown;
  /** A normal runtime boundary, not an unexpected exception. */
  readonly expectedStop?: StopReason;
  readonly cancelled: boolean;
  readonly persistence: AgentPersistenceService;
  readonly ownerUserId: string;
  readonly thread: AgentThread;
  readonly userMessage: AgentMessage;
  readonly run: AgentRun;
  readonly liveEvents?: AgentEventSink;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly transcript?: readonly TranscriptEntry[];
}): Promise<AgentExecutionResult> {
  const runShort = input.run.id.slice(0, 8);
  const knownFailure = describeRunFailure(input.error, input.transcript ?? []);
  const failureCode = input.failureCode ?? knownFailure?.code ?? "AGENT_EXECUTION_FAILED";
  const failureMessage = input.failureMessage ?? knownFailure?.message ?? "Agent execution failed. Please try again.";

  // Idempotent: if already terminal (e.g. outer safety net after settle),
  // do not attempt another status transition or duplicate terminal SSE.
  let alreadyTerminal = false;
  let assistantMessage: AgentMessage | null = null;
  try {
    const current = await input.persistence.getRun({
      runId: input.run.id,
      ownerUserId: input.ownerUserId,
    });
    if (
      current &&
      (current.status === "completed" ||
        current.status === "completed_with_input_needed" ||
        current.status === "failed" ||
        current.status === "cancelled")
    ) {
      alreadyTerminal = true;
    }
  } catch {
    // fall through and attempt settle
  }

  if (!alreadyTerminal) {
    try {
      if (input.expectedStop && !input.cancelled) {
        assistantMessage = await input.persistence.withTransaction(async (tx) => {
          const message = await input.persistence.appendMessage({
            threadId: input.thread.id,
            ownerUserId: input.ownerUserId,
            role: "assistant",
            content: failureMessage,
          }, tx);
          await input.persistence.updateRunStatus({
            runId: input.run.id,
            ownerUserId: input.ownerUserId,
            status: "failed",
            errorCode: failureCode,
            errorMessage: failureMessage,
            resultMessageId: message.id,
          }, tx);
          return message;
        });
      } else {
        await updateRunAfterError(
          input.persistence,
          input.ownerUserId,
          input.run.id,
          input.cancelled,
          failureCode,
          failureMessage,
        );
      }
    } catch (finalizeError) {
      console.error(
        `[agent] run=${runShort} terminal_finalize_failed reason=${summarizeError(finalizeError)}`,
      );
    }

    await persistTranscript(
      input.persistence,
      input.ownerUserId,
      input.run.id,
      input.transcript ?? [],
    );

    try {
      await input.liveEvents?.emit(
        input.cancelled
          ? { type: "agent.cancelled", runId: input.run.id, at: new Date().toISOString() }
          : {
              type: "agent.failed",
              runId: input.run.id,
              at: new Date().toISOString(),
              code: failureCode,
            },
      );
    } catch (emitError) {
      console.error(
        `[agent] run=${runShort} terminal_emit_failed reason=${summarizeError(emitError)}`,
      );
    }
  }

  if (!input.cancelled && input.expectedStop === undefined) {
    console.error(`[agent] run=${runShort} failed reason=${summarizeError(input.error)}`);
  }

  return {
    thread: input.thread,
    userMessage: input.userMessage,
    run: await loadTerminalRun(
      input.persistence,
      input.ownerUserId,
      input.run,
      input.cancelled,
      failureCode,
      failureMessage,
    ),
    assistantMessage,
  };
}

/** Only known, safe reasons reach persisted run status and the Agent Panel. */
export function describeRunFailure(error: unknown, transcript: readonly TranscriptEntry[]): { code: string; message: string } | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "AGENT_PERSISTENCE_FAILED") {
    return { code, message: "Could not save agent document changes. The previous version is unchanged." };
  }
  if (code === "MANAGED_USAGE_DISABLED" || code === "MANAGED_TRIAL_DISABLED") {
    return { code: String(code), message: "Managed AI is unavailable. Add your own API key in AI & Models settings." };
  }
  if (code === "MANAGED_USAGE_EXHAUSTED" || code === "MANAGED_TRIAL_EXHAUSTED") {
    return { code: String(code), message: "Managed AI credits are exhausted. Add your own API key in AI & Models settings." };
  }
  if (code === "MANAGED_USAGE_ACCOUNTING_FAILED" || code === "MANAGED_TRIAL_ACCOUNTING_FAILED") {
    return { code: String(code), message: "Managed AI is temporarily unavailable. Use your own API key or try again later." };
  }
  if (transcript.some((entry) => entry.status === "failed" && entry.summary.includes("NO_ACTIVE_DOCUMENT"))) {
    return { code: "NO_ACTIVE_DOCUMENT", message: "No document was active, and the agent tried to edit before creating one. Retry the request or open a document first." };
  }
  if (error instanceof Error && /Invalid '(?:input|tools)\[\d+\]\.name'/.test(error.message)) {
    return { code: "MODEL_TOOL_NAME_REJECTED", message: "The AI provider rejected a document tool name. Please try another model or contact support." };
  }
  return null;
}

async function updateRunAfterError(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  runId: string,
  cancelled: boolean,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  await persistence.updateRunStatus({
    runId,
    ownerUserId,
    status: cancelled ? "cancelled" : "failed",
    ...(cancelled
      ? {}
      : { errorCode: failureCode, errorMessage: failureMessage }),
  });
}

async function loadTerminalRun(
  persistence: AgentPersistenceService,
  ownerUserId: string,
  fallback: AgentRun,
  cancelled: boolean,
  failureCode: string,
  failureMessage: string,
): Promise<AgentRun> {
  const terminalStatus = cancelled ? "cancelled" : "failed";
  try {
    const run = await persistence.getRun({ runId: fallback.id, ownerUserId });
    if (run?.status === terminalStatus) return run;
  } catch {
    // fall through to in-memory terminal snapshot
  }
  return {
    ...fallback,
    status: terminalStatus,
    completedAt: new Date().toISOString(),
    errorCode: cancelled ? null : failureCode,
    errorMessage: cancelled ? null : failureMessage,
  };
}

export function keepLeaseUntilFinished<T>(leases: AgentExecutionLeaseService, lease: AgentExecutionLease, result: Promise<T>): Promise<T> {
  const timer = setInterval(() => void leases.renew(lease).catch(() => undefined), AGENT_EXECUTION_LEASE_RENEW_MS);
  timer.unref?.();
  return result.finally(async () => {
    clearInterval(timer);
    await releaseLease(leases, lease);
  });
}

export async function releaseLease(leases: AgentExecutionLeaseService, lease: AgentExecutionLease): Promise<void> {
  await leases.release(lease).catch(() => undefined);
}
