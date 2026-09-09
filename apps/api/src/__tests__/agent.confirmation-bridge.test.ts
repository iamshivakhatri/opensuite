import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  ToolRegistry,
  assistantOnlyResponse,
  createFakeTool,
  createScriptedAgentModel,
  delay,
  toolCallResponse,
  type AgentRequest,
} from "@opensuite/agent-core";

import { createHttpConfirmationBridge } from "../agent/confirmation-bridge.js";

/**
 * Deterministic, DB-free tests for the confirmation HTTP bridge: it only
 * needs an AgentRunner + a destructive tool, exactly like agent-core's own
 * CONFIRMATION/CANCELLATION tests in runner.test.ts.
 */

function baseRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    instruction: "Delete it",
    threadId: "thread-1",
    runId: "run-1",
    ...overrides,
  };
}

/** Poll until the bridge reports a pending confirmation for this run. */
async function waitForPending(
  bridge: ReturnType<typeof createHttpConfirmationBridge>,
  runId: string,
  timeoutMs = 2_000,
): Promise<{ toolCallId: string; toolName: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = bridge.getPending(runId);
    if (pending) {
      return pending;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for pending confirmation on ${runId}`);
}

test("CONFIRMATION BRIDGE: approve lets the waiting tool execute exactly once", async () => {
  let executeCount = 0;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executeCount += 1;
      return true;
    },
  });
  const bridge = createHttpConfirmationBridge();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "call-1", name: "slides.delete_slide", input: {} }]),
      assistantOnlyResponse("deleted"),
    ]),
    tools: ToolRegistry.create([tool]),
    confirmation: bridge,
  });

  const request = baseRequest({ runId: "run-approve" });
  const runPromise = runner.run(request);

  const pending = await waitForPending(bridge, request.runId);
  assert.equal(pending.toolCallId, "call-1");
  assert.equal(pending.toolName, "slides.delete_slide");

  const outcome = bridge.resolve({
    runId: request.runId,
    toolCallId: pending.toolCallId,
    approve: true,
  });
  assert.equal(outcome, "resolved");

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(executeCount, 1);
  assert.equal(result.toolOutcomes[0]?.status, "succeeded");
  assert.equal(bridge.getPending(request.runId), null);
});

test("CONFIRMATION BRIDGE: deny resolves through existing denied/skipped behavior", async () => {
  let executeCount = 0;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executeCount += 1;
      return true;
    },
  });
  const bridge = createHttpConfirmationBridge();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "call-1", name: "slides.delete_slide", input: {} }]),
      assistantOnlyResponse("skipped"),
    ]),
    tools: ToolRegistry.create([tool]),
    confirmation: bridge,
  });

  const request = baseRequest({ runId: "run-deny" });
  const runPromise = runner.run(request);

  const pending = await waitForPending(bridge, request.runId);
  const outcome = bridge.resolve({
    runId: request.runId,
    toolCallId: pending.toolCallId,
    approve: false,
  });
  assert.equal(outcome, "resolved");

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(executeCount, 0);
  assert.equal(result.toolOutcomes[0]?.status, "skipped");
  assert.equal(result.toolOutcomes[0]?.diagnostic?.code, "CONFIRMATION_DENIED");
});

test("CONFIRMATION BRIDGE: stale, duplicate, and unknown resolutions are rejected cleanly", async () => {
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      return true;
    },
  });
  const bridge = createHttpConfirmationBridge();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "call-1", name: "slides.delete_slide", input: {} }]),
      assistantOnlyResponse("done"),
    ]),
    tools: ToolRegistry.create([tool]),
    confirmation: bridge,
  });

  const request = baseRequest({ runId: "run-stale" });
  const runPromise = runner.run(request);
  const pending = await waitForPending(bridge, request.runId);

  // Unknown run.
  assert.equal(
    bridge.resolve({ runId: "no-such-run", toolCallId: pending.toolCallId, approve: true }),
    "not_found",
  );

  // Stale/mismatched toolCallId on a real run.
  assert.equal(
    bridge.resolve({ runId: request.runId, toolCallId: "wrong-call", approve: true }),
    "not_found",
  );

  // Real resolution succeeds once.
  assert.equal(
    bridge.resolve({ runId: request.runId, toolCallId: pending.toolCallId, approve: true }),
    "resolved",
  );

  // Duplicate resolution of the same (now-settled) confirmation is rejected.
  assert.equal(
    bridge.resolve({ runId: request.runId, toolCallId: pending.toolCallId, approve: false }),
    "not_found",
  );

  await runPromise;
});

test("CONFIRMATION BRIDGE: cancellation while waiting resolves as cancelled, not denied", async () => {
  let executeCount = 0;
  const tool = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    async execute() {
      executeCount += 1;
      return true;
    },
  });
  const bridge = createHttpConfirmationBridge();
  const controller = new AbortController();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "call-1", name: "slides.delete_slide", input: {} }]),
      assistantOnlyResponse("should not reach"),
    ]),
    tools: ToolRegistry.create([tool]),
    confirmation: bridge,
  });

  const request = baseRequest({ runId: "run-cancel" });
  const runPromise = runner.run(request, { signal: controller.signal });

  await waitForPending(bridge, request.runId);
  controller.abort();

  const result = await runPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(executeCount, 0);
  // Cancellation unblocks the bridge's internal wait; nothing is left pending.
  assert.equal(bridge.getPending(request.runId), null);

  // A late approve/deny attempt after cancellation finds nothing pending.
  assert.equal(
    bridge.resolve({ runId: request.runId, toolCallId: "call-1", approve: true }),
    "not_found",
  );
});
