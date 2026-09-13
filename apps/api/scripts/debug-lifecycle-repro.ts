/**
 * TEMP: one-shot lifecycle repro — delete after diagnosis.
 *
 *   AGENT_DEBUG_LIFECYCLE=1 OPENROUTER_MODEL=nex-agi/nex-n2.5-mini:free \
 *     pnpm --filter @opensuite/api exec tsx scripts/debug-lifecycle-repro.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AgentRunner,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createInMemoryDocumentMutationExecutor,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  type DocumentRuntime,
} from "@opensuite/agent-core";

import { createConfiguredAgentModel } from "../src/agent/model/index.js";
import type { AgentModelConfig } from "../src/config/index.js";

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "../../.env"));

process.env.AGENT_DEBUG_LIFECYCLE = "1";

const apiKey = process.env.OPENROUTER_API_KEY;
const modelId =
  process.env.OPENROUTER_MODEL?.trim() || "nex-agi/nex-n2.5-mini:free";
if (!apiKey) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const agentConfig: AgentModelConfig = {
  provider: "openrouter",
  openrouterApiKey: apiKey,
  openrouterModel: modelId,
  anthropicApiKey: null,
  anthropicModel: "claude-sonnet-4-5",
  openaiApiKey: null,
  openaiModel: "gpt-4.1",
};

const model = createConfiguredAgentModel(agentConfig);

const store = new Map<string, Uint8Array>();
const runtime: DocumentRuntime = {
  async capabilities() {
    return mutableDocumentCapabilities();
  },
  async inspect() {
    return {
      status: "success",
      snapshot: {
        documentId: "repro-doc",
        versionId: "repro-v1",
        format: "docx",
        outline: [],
        paragraphs: [],
        tables: [],
      },
    };
  },
  async find() {
    return { status: "success", matches: [] };
  },
  async execute() {
    return {
      status: "success",
      result: { applied: true },
      diagnostics: [],
    };
  },
};

const mutations = createInMemoryDocumentMutationExecutor({ store });
const createTool = {
  name: "workspace.create_blank_docx",
  description:
    "Create a new blank Word (.docx) document. Call ALONE first when user wants a new document.",
  risk: "safe" as const,
  effect: "write" as const,
  executionMode: "sequential" as const,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
  },
  async execute() {
    const documentId = `doc_${Date.now()}`;
    const versionId = `${documentId}_v1`;
    store.set(versionId, new Uint8Array([0x50, 0x4b]));
    return {
      status: "succeeded" as const,
      summary: `Created ${documentId}`,
      output: {
        documentId,
        versionId,
        name: "Fitness Routine",
        format: "docx",
      },
    };
  },
};

const tools = ToolRegistry.create([createTool]);
const runner = new AgentRunner({
  model,
  ...createDocumentAgentRunnerOptions({
    tools,
    documentToolCatalog: listDocumentToolDescriptors(),
    runtime,
    mutations,
    primaryDocument: null,
  }),
  modelTurnTimeoutMs: 90_000,
  maxTurns: 20,
});

const prompt =
  "can you create a new document with fitness routine that i can follow as fulltime working man. i want routine for whole week";

console.log(`[repro] model=${modelId}`);
console.log(`[repro] AGENT_DEBUG_LIFECYCLE=${process.env.AGENT_DEBUG_LIFECYCLE}`);
const startedAt = Date.now();
try {
  const result = await runner.run({
    instruction: prompt,
    threadId: "repro-thread",
    runId: "repro-run",
  });
  console.log(
    `[repro] status=${result.status} elapsedMs=${Date.now() - startedAt}`,
  );
  console.log(`[repro] summary=${result.summary.slice(0, 240)}`);
  console.log(
    `[repro] diagnostics=${JSON.stringify(result.diagnostics).slice(0, 500)}`,
  );
} catch (error) {
  console.error(`[repro] threw after ${Date.now() - startedAt}ms`, error);
  process.exit(1);
}
