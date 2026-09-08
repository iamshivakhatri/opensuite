/**
 * Live smoke: OpenRouter must call workspace.create_blank_docx for greenfield.
 *
 *   pnpm --filter @opensuite/agent-core build
 *   pnpm --filter @opensuite/api exec tsx scripts/smoke-greenfield-agent.ts
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
  type ModelRequest,
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

const apiKey = process.env.OPENROUTER_API_KEY;
const modelId = process.env.OPENROUTER_MODEL;
if (!apiKey || !modelId) {
  console.error("OPENROUTER_API_KEY / OPENROUTER_MODEL required");
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

let createCalls = 0;
const createTool = {
  name: "workspace.create_blank_docx",
  description:
    "Create a new blank Word (.docx) document. Call ALONE first when user wants a new document.",
  risk: "safe" as const,
  effect: "write" as const,
  executionMode: "sequential" as const,
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  },
  parseInput(raw: unknown) {
    if (!raw || typeof raw !== "object") return {};
    const name = (raw as { name?: unknown }).name;
    return typeof name === "string" ? { name } : {};
  },
  async execute(
    input: { name?: string },
    ctx: {
      advancePrimaryDocument?: (doc: {
        documentId: string;
        versionId: string;
        format: "docx";
      }) => void;
    },
  ) {
    createCalls += 1;
    const document = {
      documentId: "smoke-doc",
      versionId: "smoke-v1",
      format: "docx" as const,
    };
    ctx.advancePrimaryDocument?.(document);
    return {
      document: {
        ...document,
        name: input.name ?? "Smoke Plan.docx",
        versionNumber: 1,
      },
    };
  },
};

const runtime: DocumentRuntime = {
  async capabilities() {
    return mutableDocumentCapabilities();
  },
  async inspect() {
    return {
      status: "success",
      format: "docx",
      capabilities: mutableDocumentCapabilities(),
      diagnostics: [],
      focus: { kind: "overview" },
      payload: {
        format: "docx",
        summary: { title: null, unitKind: "page", unitCount: 0 },
      },
    };
  },
  async execute() {
    return {
      status: "success",
      diagnostics: [],
      artifactBytes: new Uint8Array([1]),
    };
  },
};

const toolChoices: Array<string | undefined> = [];
const wrappedModel = {
  async complete(request: ModelRequest) {
    toolChoices.push(request.toolChoice);
    console.log(
      `[smoke] model.complete tools=${request.tools.length} toolChoice=${request.toolChoice ?? "auto"}`,
    );
    const startedAt = Date.now();
    const response = await model.complete(request);
    console.log(
      `[smoke] model done ${Date.now() - startedAt}ms toolCalls=${response.toolCalls.length} contentChars=${response.content.length}`,
    );
    for (const call of response.toolCalls) {
      console.log(`[smoke]   → ${call.name}`);
    }
    return response;
  },
};

const runner = new AgentRunner({
  model: wrappedModel,
  ...createDocumentAgentRunnerOptions({
    tools: ToolRegistry.create([createTool]),
    documentToolCatalog: listDocumentToolDescriptors(),
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
  }),
  modelTurnTimeoutMs: 90_000,
  maxTurns: 20,
});

const prompt =
  "can you create me a new docs which should give me all the content ideas as a niche to fashion/ makeup/skincare girly, my aud is 20-30 female, create some exciting ideas for the fashion, i have few clothes which has sophisticated aesthetic and i want to film it in downtown with videoes and pics create table with ideas, songs, plan everything.";

console.log(`[smoke] model=${modelId}`);
const started = Date.now();

async function main(): Promise<void> {
  const result = await runner.run({
    instruction: prompt,
    threadId: "smoke-thread",
    runId: "smoke-run",
  });
  const elapsed = Date.now() - started;

  console.log(`[smoke] status=${result.status} elapsedMs=${elapsed}`);
  console.log(
    `[smoke] tools=${result.toolOutcomes.map((o) => `${o.toolName}:${o.status}`).join(", ")}`,
  );
  console.log(
    `[smoke] createCalls=${createCalls} toolChoices=${toolChoices.join(",")}`,
  );
  console.log(`[smoke] summary=${result.summary.slice(0, 200)}`);

  if (createCalls < 1) {
    console.error("[smoke] FAIL: never called workspace.create_blank_docx");
    process.exit(1);
  }
  if (toolChoices[0] !== "required") {
    console.error("[smoke] FAIL: first turn toolChoice was not required");
    process.exit(1);
  }

  const createOutcome = result.toolOutcomes.find(
    (o) => o.toolName === "workspace.create_blank_docx",
  );
  if (createOutcome?.status !== "succeeded") {
    console.error("[smoke] FAIL: create_blank_docx did not succeed");
    process.exit(1);
  }

  const wrote = result.toolOutcomes.some(
    (o) =>
      o.toolName.startsWith("document.") &&
      o.toolName !== "document.inspect" &&
      o.status === "succeeded",
  );
  if (!wrote) {
    console.error("[smoke] FAIL: no successful document write after create");
    process.exit(1);
  }

  if (result.status !== "completed") {
    console.error(`[smoke] FAIL: expected completed, got ${result.status}: ${result.summary}`);
    process.exit(1);
  }

  if (elapsed > 180_000) {
    console.error(`[smoke] FAIL: run too slow (${elapsed}ms)`);
    process.exit(1);
  }

  console.log("[smoke] PASS");
}

main().catch((error) => {
  console.error("[smoke] FAIL:", error);
  process.exit(1);
});
