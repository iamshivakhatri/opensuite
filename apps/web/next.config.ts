import path from "node:path";
import { createRequire } from "node:module";
import type { NextConfig } from "next";

const require = createRequire(import.meta.url);

/**
 * @schnsrw/core ships wasm under `wasm/` but its glue resolves
 * `s1engine_wasm_bg.wasm` relative to the JS file under `dist/`.
 */
function resolveSchnsrwWasm(): string {
  const entry = require.resolve("@schnsrw/core");
  return path.join(
    path.dirname(entry),
    "..",
    "wasm",
    "s1engine_wasm_bg.wasm",
  );
}

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
      "s1engine_wasm_bg.wasm": resolveSchnsrwWasm(),
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "s1engine_wasm_bg.wasm": resolveSchnsrwWasm(),
    };
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

export default nextConfig;
