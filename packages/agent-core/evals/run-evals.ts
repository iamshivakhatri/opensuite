import { ALL_SCENARIOS, type EvalScenarioResult } from "./scenarios.js";

function formatRow(row: EvalScenarioResult): string {
  const status = row.pass ? "PASS" : "FAIL";
  const tools = row.toolNames.length > 0 ? row.toolNames.join("|") : "-";
  const detail = row.detail ? ` detail=${row.detail}` : "";
  return `${status}  ${row.scenario}  turns=${row.modelTurns}  toolCalls=${row.toolCalls}  tools=${tools}  stop=${row.stopReason}${detail}`;
}

async function main(): Promise<void> {
  const rows: EvalScenarioResult[] = [];
  for (const run of ALL_SCENARIOS) {
    rows.push(await run());
  }

  for (const row of rows) {
    console.log(formatRow(row));
  }

  const failed = rows.filter((r) => !r.pass);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} passed` +
      (failed.length ? ` — failed: ${failed.map((f) => f.scenario).join(", ")}` : ""),
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
