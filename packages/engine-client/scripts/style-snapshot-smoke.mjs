/**
 * Smoke: load a DOCX through the installed native engine and print a concise
 * style-snapshot summary. Uses published `@opensuitehq/engine` unless
 * OPENSUITE_ENGINE_PATH is set for local engine development.
 *
 * Run: pnpm --filter @opensuite/engine-client style-smoke
 */

import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  inspectDocxStyleSnapshot,
  resolveNativeEngineModuleId,
} from "../dist/index.js";

const { moduleId, fromEnv } = resolveNativeEngineModuleId();
const binding = await createNapiDocxEngineBinding();
const caps = binding.getDocxCapabilities();
const bytes = new Uint8Array(
  buildMinimalDocx(["Style snapshot smoke"]),
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
console.log(
  `source: ${fromEnv ? "OPENSUITE_ENGINE_PATH" : "npm"} → ${moduleId}`,
);
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
