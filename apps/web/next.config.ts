import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path — webpack only. Turbopack rejects absolute aliases. */
const schnsrwWasmAbsolute = path.join(webRoot, "vendor", "s1engine_wasm_bg.wasm");
/**
 * Project-relative — required for Turbopack. The binary is synced into
 * apps/web/vendor by scripts/sync-schnsrw-wasm.mjs (pnpm monorepo node_modules
 * sit outside the Next project root and are not resolvable).
 */
const schnsrwWasmRelative = "./vendor/s1engine_wasm_bg.wasm";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@casualoffice/docs", "@schnsrw/core"],
  serverExternalPackages: [
    "@huggingface/transformers",
    "@mlc-ai/web-llm",
    "onnxruntime-node",
  ],
  turbopack: {
    resolveAlias: {
      "s1engine_wasm_bg.wasm": schnsrwWasmRelative,
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "s1engine_wasm_bg.wasm": schnsrwWasmAbsolute,
    };
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

export default nextConfig;
