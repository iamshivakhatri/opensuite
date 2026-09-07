import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBenchmarkRecord,
  elapsedMs,
  type AgentModel,
  type BenchmarkRunRecord,
} from "@opensuite/agent-core";

import { createBenchHarness } from "./harness.js";
import { identifyBottleneck, printBenchmarkReport } from "./report.js";
import {
  freshRunId,
  selectScenarios,
  type BenchScenario,
} from "./scenarios.js";

/** apps/api/src/agent/bench → repo root (5 levels up). */
const REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../..",
);

export interface RunBenchSuiteOptions {
  readonly model: AgentModel;
  readonly provider: string;
  readonly modelId: string;
  /** Comma-separated scenario ids or A,B,C… Default: all. */
  readonly scenarioFilter?: string;
  /** Directory for JSON output (gitignored). */
  readonly outDir?: string;
  readonly quiet?: boolean;
}

export interface BenchSuiteResult {
  readonly records: readonly BenchmarkRunRecord[];
  readonly jsonPath: string | null;
  readonly bottleneckSummary: string;
}

export async function runBenchSuite(
  options: RunBenchSuiteOptions,
): Promise<BenchSuiteResult> {
  const scenarios = selectScenarios(options.scenarioFilter);
  const harness = await createBenchHarness();
  const records: BenchmarkRunRecord[] = [];

  if (!options.quiet) {
    console.log(
      `Agent bench: provider=${options.provider} model=${options.modelId} scenarios=${scenarios.map((s) => s.id).join(",")}`,
    );
  }

  for (const scenario of scenarios) {
    const record = await runOneScenario(harness, scenario, options);
    records.push(record);
    if (!options.quiet) {
      console.log(
        `  ${scenario.id}: ${record.success ? "ok" : "FAIL"} turns=${record.modelTurns} total=${(record.totalWallMs / 1000).toFixed(1)}s model=${(record.aggregate.totalModelMs / 1000).toFixed(1)}s tools=${(record.aggregate.totalToolMs / 1000).toFixed(1)}s`,
      );
    }
  }

  if (!options.quiet) {
    printBenchmarkReport(records);
  }

  const bottleneckSummary = identifyBottleneck(records);
  if (!options.quiet) {
    console.log(bottleneckSummary);
  }

  let jsonPath: string | null = null;
  const outDir = options.outDir ?? resolve(REPO_ROOT, ".agent-bench");
  try {
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    jsonPath = resolve(
      outDir,
      `${stamp}_${options.provider}_${sanitize(options.modelId)}.json`,
    );
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          provider: options.provider,
          model: options.modelId,
          startedAt: records[0]?.startedAt,
          finishedAt: records[records.length - 1]?.finishedAt,
          bottleneckSummary,
          records,
        },
        null,
        2,
      ),
      "utf8",
    );
    if (!options.quiet) {
      console.log(`Wrote ${jsonPath}`);
    }
  } catch (error) {
    if (!options.quiet) {
      console.warn(
        `Could not persist JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { records, jsonPath, bottleneckSummary };
}

async function runOneScenario(
  harness: Awaited<ReturnType<typeof createBenchHarness>>,
  scenario: BenchScenario,
  options: RunBenchSuiteOptions,
): Promise<BenchmarkRunRecord> {
  const primary = scenario.seed(harness);
  const startedAtDate = new Date();
  const wallStart = Date.now();

  const { result, events, totalPersistMs } = await harness.run({
    model: options.model,
    instruction: scenario.instruction,
    primaryDocument: primary,
    runId: freshRunId(scenario.id),
  });

  const finishedAtDate = new Date();
  const toolNames = result.toolOutcomes.map((o) => o.toolName);
  const check = scenario.check({ result, toolNames });

  return buildBenchmarkRecord({
    scenario: scenario.id,
    provider: options.provider,
    model: options.modelId,
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    totalWallMs: elapsedMs(wallStart),
    events,
    result,
    correctnessOk: check.ok,
    correctnessNotes: check.notes,
    totalPersistMs,
  });
}

function sanitize(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
