/**
 * Manual Phase 1 dogfood: load a DOCX through the local native engine and
 * print a concise style-snapshot summary.
 *
 * Requires OPENSUITE_ENGINE_PATH pointing at opensuite-node/index.js.
 * Run: pnpm --filter @opensuite/engine-client style-smoke
 */

import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  inspectDocxStyleSnapshot,
  resolveNativeEngineModuleId,
} from "../dist/index.js";

const { moduleId, fromEnv } = resolveNativeEngineModuleId();
if (!fromEnv) {
  console.error(
    "OPENSUITE_ENGINE_PATH is unset; refusing to smoke against the published package.\n" +
      "Example:\n" +
      '  OPENSUITE_ENGINE_PATH="$PWD/../opensuite-engine/crates/opensuite-node/index.js" pnpm --filter @opensuite/engine-client style-smoke',
  );
  process.exit(1);
}

const binding = await createNapiDocxEngineBinding();
const caps = binding.getDocxCapabilities();
const bytes = new Uint8Array(
  buildMinimalDocx(["Phase 1 style snapshot smoke"]),
);
const snapshot = await inspectDocxStyleSnapshot(bytes, binding);

const fonts = snapshot.typography.fonts.map((f) => f.value).join(", ") || "(none)";
const paragraphStyles =
  snapshot.styles
    .filter((s) => s.styleType === "paragraph")
    .map((s) => s.styleId)
    .join(", ") || "(none)";
const colors =
  snapshot.typography.textColors.map((c) => c.value).join(", ") || "(none)";
const headerFooter =
  snapshot.headersFooters.length === 0
    ? "none"
    : snapshot.headersFooters
        .map((h) => `s${h.sectionIndex}:${h.kind}/${h.variant}`)
        .join(", ");

console.log(`engine: ${caps.engineVersion}`);
console.log(`source: OPENSUITE_ENGINE_PATH → ${moduleId}`);
console.log(`ok: ${snapshot.ok} schemaVersion: ${snapshot.schemaVersion}`);
console.log(`fonts: ${fonts}`);
console.log(`paragraphStyles: ${paragraphStyles}`);
console.log(`colors: ${colors}`);
console.log(`tables: ${snapshot.tableCount}`);
console.log(`sections: ${snapshot.sectionCount}`);
console.log(`headersFooters: ${headerFooter}`);
console.log(
  `counts: paragraphs=${snapshot.paragraphCount} runs=${snapshot.runCount} truncated=${snapshot.truncated}`,
);
