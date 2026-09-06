/**
 * @schnsrw/core's wasm-bindgen glue does:
 *   new URL("s1engine_wasm_bg.wasm", import.meta.url)
 * but the binary ships under `wasm/`, not next to the JS in `dist/`.
 *
 * Turbopack also rejects absolute resolveAlias targets ("server relative
 * imports are not implemented"). Copy the binary next to the glue JS and
 * into apps/web/vendor for a project-relative alias.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const entry = require.resolve("@schnsrw/core");
const distDir = path.dirname(entry);
const src = path.join(distDir, "..", "wasm", "s1engine_wasm_bg.wasm");

if (!existsSync(src)) {
  console.warn(`[sync-schnsrw-wasm] missing source: ${src}`);
  process.exit(0);
}

const distTarget = path.join(distDir, "s1engine_wasm_bg.wasm");
copyFileSync(src, distTarget);

const vendorDir = path.join(webRoot, "vendor");
mkdirSync(vendorDir, { recursive: true });
const vendorTarget = path.join(vendorDir, "s1engine_wasm_bg.wasm");
copyFileSync(src, vendorTarget);

console.log(`[sync-schnsrw-wasm] synced → dist + vendor`);
