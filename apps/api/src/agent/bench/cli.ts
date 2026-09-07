/**
 * Developer agent benchmark CLI.
 *
 *   pnpm agent:bench
 *   PROVIDER=openrouter MODEL=... SCENARIO=simple-read,greenfield-large pnpm agent:bench
 *
 * Uses the same AgentRunner + document tools + engine path as production.
 * Secrets come from env / .env — never hardcoded.
 */
import "../../load-env.js";

import { createConfiguredAgentModel } from "../model/index.js";
import { loadConfig, type AgentModelProvider } from "../../config/index.js";
import { runBenchSuite } from "./run-suite.js";

const PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "fake",
]);

async function main(): Promise<void> {
  const envProvider =
    process.env.PROVIDER?.trim() || process.env.AGENT_MODEL_PROVIDER;
  const envModel =
    process.env.MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim();

  // Allow PROVIDER/MODEL overrides without rewriting the full .env.
  if (envProvider && PROVIDERS.has(envProvider)) {
    process.env.AGENT_MODEL_PROVIDER = envProvider;
  }
  if (envModel) {
    const provider =
      process.env.AGENT_MODEL_PROVIDER ?? envProvider ?? "unconfigured";
    if (provider === "openrouter") {
      process.env.OPENROUTER_MODEL = envModel;
    } else if (provider === "openai") {
      process.env.OPENAI_MODEL = envModel;
    } else if (provider === "anthropic") {
      process.env.ANTHROPIC_MODEL = envModel;
    }
  }

  const config = loadConfig();
  const provider = config.agent.provider as AgentModelProvider;

  if (provider === "unconfigured") {
    console.error(
      "Agent model provider is unconfigured. Set AGENT_MODEL_PROVIDER (or PROVIDER) to openrouter|openai|anthropic.",
    );
    process.exitCode = 1;
    return;
  }

  if (provider === "fake") {
    console.warn(
      "Warning: AGENT_MODEL_PROVIDER=fake does not call tools — results are not meaningful for document workloads.",
    );
  }

  const modelId =
    provider === "openrouter"
      ? (config.agent.openrouterModel ?? "unknown")
      : provider === "openai"
        ? config.agent.openaiModel
        : provider === "anthropic"
          ? config.agent.anthropicModel
          : "fake";

  const model = createConfiguredAgentModel(config);

  const { records } = await runBenchSuite({
    model,
    provider,
    modelId,
    scenarioFilter: process.env.SCENARIO ?? process.env.SCENARIOS,
  });

  const failed = records.filter((r) => !r.success).length;
  if (failed > 0) {
    console.error(
      `\n${failed}/${records.length} scenario(s) failed correctness or status.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\nAll ${records.length} scenario(s) passed correctness checks.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
