import type { AgentEvent } from "@opensuite/agent-core-v3";
import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";
import type { CapabilityEvent } from "./session.js";
import type { CapabilitySession } from "./session.js";

export type StoredCapabilityEvent = CapabilityEvent & Readonly<{
  runId: string;
  model: string;
  occurredAt: Date;
}>;
export type CapabilityEventSink = (events: readonly StoredCapabilityEvent[]) => Promise<void>;

export function createCapabilityEventSink(db: Db): CapabilityEventSink {
  return async (events) => {
    if (!events.length) return;
    await db.insert(schema.agentCapabilityEvent).values(events.map((event) => ({
      runId: event.runId,
      turn: event.turn ?? null,
      capabilityId: event.capabilityId,
      capabilityKind: event.kind,
      eventType: event.type,
      model: event.model,
      occurredAt: event.occurredAt,
      latencyMs: event.latencyMs === undefined ? null : Math.round(event.latencyMs),
      errorCode: event.errorCode ?? null,
    })));
  };
}

/** Buffer small raw events; one best-effort write after the document run. */
export function createCapabilityTelemetry(runId: string, model: string, sink?: CapabilityEventSink) {
  const events: StoredCapabilityEvent[] = [];
  const started = new Map<string, number>();
  let turn = 0;
  const record = (event: CapabilityEvent) => {
    events.push({ ...event, runId, model, occurredAt: new Date() });
  };
  const runtimeEvent = (event: AgentEvent, session?: CapabilitySession) => {
    if (event.type === "model_turn_started") { turn = event.turn; return; }
    if (event.type !== "tool_started" && event.type !== "tool_completed" && event.type !== "tool_failed") return;
    const capabilityId = session?.capabilityForTool(event.toolName);
    if (!capabilityId) return;
    const kind = "tool" as const;
    if (event.type === "tool_started") {
      started.set(event.toolCallId, performance.now());
      record({ capabilityId, kind, type: "executed", turn });
      return;
    }
    const start = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    record({ capabilityId, kind, type: event.type === "tool_completed" ? "succeeded" : "failed", turn,
      ...(start !== undefined ? { latencyMs: performance.now() - start } : {}),
      ...(event.type === "tool_failed" ? { errorCode: /^[A-Z][A-Z0-9_]{1,80}$/.test(event.error) ? event.error : "TOOL_ERROR" } : {}),
    });
  };
  return {
    record,
    runtimeEvent,
    events: () => [...events],
    async flush() {
      if (!sink || !events.length) return;
      try { await sink(events); }
      catch (error) { console.warn(`[agent] capability telemetry write failed run=${runId}: ${error instanceof Error ? error.message : "unknown"}`); }
    },
  };
}
