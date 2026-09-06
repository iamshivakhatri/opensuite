/**
 * Turbopack only emits .wasm assets that appear in the app module graph.
 * @schnsrw/core references `s1engine_wasm_bg.wasm` via import.meta.url inside
 * node_modules (outside the Next project root in this pnpm monorepo), so we
 * also reference the vendored copy here. next.config aliases the bare name
 * to ./vendor/s1engine_wasm_bg.wasm.
 */
void new URL("s1engine_wasm_bg.wasm", import.meta.url);
