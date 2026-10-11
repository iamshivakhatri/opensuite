/**
 * Native engine acceptance: proves which binary loaded and that semantic
 * table edits work end to end, entirely in memory.
 *
 * Fails when OPENSUITE_ENGINE_PATH or a NAPI-RS loader override is set,
 * unless --allow-overrides is passed (then it reports the override identity).
 *
 * Run: pnpm --filter @opensuite/engine-client native-acceptance
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  bindDocxDocument,
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  describeNativeEngine,
  nativeSupportsSemanticTableCellTargets,
  nativeSupportsSemanticTableRowDeletion,
} from "../dist/index.js";

const allowOverrides = process.argv.includes("--allow-overrides");

function fail(message) {
  console.error(`[native-acceptance] FAIL: ${message}`);
  process.exit(1);
}

const binding = await createNapiDocxEngineBinding();
const caps = binding.getDocxCapabilities();
const engine = await describeNativeEngine(binding);
const overridden = engine.fromEnv || engine.loaderOverrides.length > 0;

console.log(`engine: ${caps.engineVersion} protocol: ${caps.protocolVersion}`);
console.log(`module: ${engine.modulePath}`);
console.log(`binary: ${engine.binaryPath ?? "unknown"} sha256: ${engine.binarySha256 ?? "unknown"}`);
console.log(`overrides: ${[engine.fromEnv ? `OPENSUITE_ENGINE_PATH=${engine.moduleId}` : "", ...engine.loaderOverrides].filter(Boolean).join(",") || "none"}`);

if (overridden && !allowOverrides) {
  fail("engine overrides are set; unset them or pass --allow-overrides");
}
if (!caps.ok) fail("getDocxCapabilities returned ok=false");
if (!engine.binaryPath && !overridden) fail("no native .node binary found in the module cache");

const wrapperPackage = JSON.parse(
  readFileSync(join(dirname(engine.modulePath), "package.json"), "utf8"),
);
console.log(`package: ${wrapperPackage.name}@${wrapperPackage.version}`);
if (wrapperPackage.version !== caps.engineVersion) {
  fail(`package version ${wrapperPackage.version} != native engineVersion ${caps.engineVersion}`);
}
if (!overridden) {
  const enginePackage = createRequire(import.meta.url)("../package.json").dependencies["@opensuitehq/engine"];
  if (enginePackage !== caps.engineVersion) {
    fail(`engine-client pins @opensuitehq/engine@${enginePackage} but native reports ${caps.engineVersion}`);
  }
}

const advertised = caps.formats.find((format) => format.format === "docx")?.capabilities ?? [];
for (const id of ["semantic_table_cell_targets", "semantic_table_row_deletion"]) {
  if (!advertised.includes(id)) fail(`native engine does not advertise ${id}`);
}
console.log("semantic ids advertised: cells=true rows=true");
if (!nativeSupportsSemanticTableCellTargets(caps)) fail("semantic table-cell targets unsupported");
if (!nativeSupportsSemanticTableRowDeletion(caps)) fail("semantic table-row deletion unsupported");

const doc = bindDocxDocument({
  binding,
  bytes: new Uint8Array(buildMinimalDocx(["Acceptance"])),
});

async function table() {
  const inspected = await doc.inspect({ focus: { kind: "tables" } });
  const first = inspected.tables?.items?.[0];
  if (!first) fail("table not found after create_table");
  return first;
}

async function mutate(capability, args) {
  const result = await doc.mutate(capability, args);
  if (!result.ok) {
    fail(`${capability}: ${result.reasonCode ?? "failed"} ${JSON.stringify(result.diagnostics ?? [])}`);
  }
  console.log(`ok: ${capability}`);
}

const header = { kind: "header" };
await mutate("create_table", {
  rows: [["Name", "Role"], ["Ada", "CEO"], ["Lin", "CTO"]],
  placement: { kind: "end" },
});
await mutate("set_table_cells_formatting", {
  table: { handle: (await table()).handle },
  updates: [{ target: { row: header, column: { kind: "first" } }, textFormatting: { bold: true } }],
});
await mutate("set_table_cell_shading", {
  table: { handle: (await table()).handle },
  updates: [{ target: { row: header, column: { kind: "header", text: "Role" } }, fill: "D9E2F3" }],
});
await mutate("set_table_cells_text", {
  table: { handle: (await table()).handle },
  updates: [{
    target: { row: { kind: "label", text: "Ada" }, column: { kind: "header", text: "Role" } },
    expectedCurrentText: "CEO",
    replacement: "Chief",
  }],
});
await mutate("delete_table_row", {
  table: { handle: (await table()).handle },
  row: { kind: "label", text: "Lin" },
});

const rows = (await table()).rows.map((row) => row.cells);
if (JSON.stringify(rows) !== JSON.stringify([["Name", "Role"], ["Ada", "Chief"]])) {
  fail(`unexpected table after edits: ${JSON.stringify(rows)}`);
}
console.log("[native-acceptance] PASS");
