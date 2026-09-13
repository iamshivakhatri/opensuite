import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCUMENT_TOOL_NAMES,
  buildBenchmarkRecord,
  createScriptedAgentModel,
  toolCallResponse,
  assistantOnlyResponse,
} from "@opensuite/agent-core";

import {
  createBenchHarness,
  createProductionBenchHarness,
} from "../agent/bench/harness.js";
import { identifyBottleneck } from "../agent/bench/report.js";
import { selectScenarios, scenarioById } from "../agent/bench/scenarios.js";
import { createScriptedBenchmarkModel } from "../agent/bench/scripted-model.js";

test("selectScenarios resolves ids and letter aliases", () => {
  assert.equal(selectScenarios("all").length, 12);
  assert.deepEqual(
    selectScenarios("A,C").map((s) => s.id),
    ["simple-read", "greenfield-small"],
  );
});

test("poem benchmark reports explicit efficiency counters", async () => {
  const harness = await createBenchHarness();
  const { result, events, totalPersistMs } = await harness.run({
    model: createScriptedAgentModel([
      toolCallResponse("", [{ id: "create", name: "workspace.create_blank_docx", input: { name: "Poems.docx" } }]),
      toolCallResponse("Done — poems are ready.", [
        { id: "body", name: DOCUMENT_TOOL_NAMES.insertParagraphs, input: { texts: ["Five Small Poems", "An introduction.", "First Poem", "A small line.", "Second Poem", "Another line.", "Third Poem", "Third line.", "Fourth Poem", "Fourth line.", "Fifth Poem", "Fifth line.", "A closing section."], placement: { kind: "end" } } },
      ]),
    ]),
    instruction: "create poems",
  });
  const record = buildBenchmarkRecord({ scenario: "greenfield-poems", provider: "scripted", model: "scripted", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), totalWallMs: 1, events, result, correctnessOk: true, totalPersistMs });
  assert.equal(record.modelTurns, 2);
  assert.equal(record.inspectCalls, 0);
  assert.equal(record.readToolCalls, 0);
  assert.equal(record.writeToolCalls, 2);
  assert.equal(record.failedToolCalls, 0);
});

test("bench harness: scripted greenfield create→batch→terminalize (native engine)", async () => {
  const harness = await createBenchHarness();
  let calls = 0;
  const model = createScriptedAgentModel([
    () => {
      calls += 1;
      return toolCallResponse("", [
        {
          id: "c1",
          name: "workspace.create_blank_docx",
          input: { name: "Bench.docx" },
        },
      ]);
    },
    () => {
      calls += 1;
      return toolCallResponse("Done — report ready with title, paragraphs, and table.", [
        {
          id: "w1",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: ["Title", "Intro one.", "Intro two."],
            placement: { kind: "end" },
          },
        },
        {
          id: "w2",
          name: DOCUMENT_TOOL_NAMES.createTable,
          input: {
            rows: [
              ["A", "B", "C"],
              ["1", "2", "3"],
              ["4", "5", "6"],
            ],
            placement: { kind: "end" },
          },
        },
        {
          id: "w3",
          name: DOCUMENT_TOOL_NAMES.insertParagraphs,
          input: {
            texts: ["Conclusion."],
            placement: { kind: "end" },
          },
        },
      ]);
    },
    () => {
      calls += 1;
      return assistantOnlyResponse("should not run");
    },
  ]);

  const { result, events, totalPersistMs } = await harness.run({
    model,
    instruction: "create a small report",
    runId: "bench-scripted-greenfield",
  });

  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.equal(result.toolOutcomes.length, 4);
  assert.ok(totalPersistMs >= 0);

  const record = buildBenchmarkRecord({
    scenario: "greenfield-small",
    provider: "scripted",
    model: "scripted",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalWallMs: 1,
    events,
    result,
    correctnessOk: true,
    totalPersistMs,
  });
  assert.equal(record.modelTurns, 2);
  assert.ok(record.versionsCreated >= 1);
  assert.ok(!result.toolOutcomes.some((o) => o.toolName === "document.capabilities"));
  assert.ok(
    !result.toolOutcomes.some((o) => o.toolName === DOCUMENT_TOOL_NAMES.inspect),
  );

  const bottleneck = identifyBottleneck([record]);
  assert.match(bottleneck, /Bottleneck:/);
});

test("production benchmark harness runs deterministic targeting and formatting plans", async () => {
  const harness = await createProductionBenchHarness();
  for (const id of [
    "target-duplicate",
    "target-recovery",
    "greenfield-poems",
    "authoring-memo",
    "authoring-guide",
    "authoring-creative",
    "launch-brief",
  ] as const) {
    const scenario = scenarioById(id)!;
    const primary = scenario.seed(harness);
    const { result, events, document } = await harness.run({
      model: createScriptedBenchmarkModel(id),
      instruction: scenario.instruction,
      primaryDocument: primary,
      runId: `scripted-${id}`,
    });
    const check = await scenario.check({
      result,
      toolNames: result.toolOutcomes.map((outcome) => outcome.toolName),
      events,
      document,
      runtime: harness.runtime,
    });
    assert.deepEqual(check, { ok: true, notes: [] }, id);
    const ambiguous = result.toolOutcomes.filter((outcome) => outcome.diagnostic?.code === "TARGET_AMBIGUOUS");
    assert.equal(ambiguous.length, id === "target-recovery" ? 1 : 0);
    if (id === "greenfield-poems") {
      assert.equal(events.filter((event) => event.type === "document.version.advanced").length, 2);
    }
  }
});
