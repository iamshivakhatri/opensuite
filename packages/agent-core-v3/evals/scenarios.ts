import { jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import {
  createFinishTool,
  defineTool,
  isSuccessfulStop,
  runAgent,
  type AgentToolSet,
  type RunAgentResult,
  type StopReason,
} from "../src/index.js";

const emptyUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const emptySchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const nSchema = jsonSchema<{ n: number }>({
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
});

function toolCallChunks(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.flatMap((call) => [
      { type: "tool-input-start", id: call.id, toolName: call.name },
      {
        type: "tool-input-delta",
        id: call.id,
        delta: JSON.stringify(call.input),
      },
      { type: "tool-input-end", id: call.id },
      {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.input),
      },
    ]),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: emptyUsage,
    },
  ];
}

function textChunks(text: string) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: text },
    { type: "text-end" as const, id: "text" },
    {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: emptyUsage,
    },
  ];
}

export interface EvalScenarioResult {
  readonly scenario: string;
  readonly pass: boolean;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly toolNames: readonly string[];
  readonly stopReason: StopReason;
  readonly detail?: string;
}

type ScriptedTurn =
  | { readonly kind: "tools"; readonly calls: ReadonlyArray<{ id: string; name: string; input: unknown }> }
  | { readonly kind: "text"; readonly text: string };

function scriptedModel(turns: readonly ScriptedTurn[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const turn = turns[i] ?? { kind: "text" as const, text: "fallback" };
      i += 1;
      const chunks =
        turn.kind === "tools"
          ? toolCallChunks([...turn.calls])
          : textChunks(turn.text);
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function summarize(
  scenario: string,
  result: RunAgentResult,
  toolNames: readonly string[],
  pass: boolean,
  detail?: string,
): EvalScenarioResult {
  return {
    scenario,
    pass,
    modelTurns: result.turns,
    toolCalls: result.toolCalls,
    toolNames,
    stopReason: result.stopReason,
    ...(detail ? { detail } : {}),
  };
}

/** A. read → mutate → finish — no extra model turn after finish. */
export async function scenarioReadMutateFinish(): Promise<EvalScenarioResult> {
  const order: string[] = [];
  const finish = createFinishTool();
  const tools: AgentToolSet = {
    inspect: defineTool({
      kind: "read",
      description: "read",
      inputSchema: emptySchema,
      execute: async () => {
        order.push("inspect");
        return { ok: true };
      },
    }),
    edit: defineTool({
      kind: "mutate",
      description: "mutate",
      inputSchema: emptySchema,
      execute: async () => {
        order.push("edit");
        return { ok: true };
      },
    }),
    [finish.name]: finish.tool,
  };

  const model = scriptedModel([
    {
      kind: "tools",
      calls: [
        { id: "1", name: "inspect", input: {} },
        { id: "2", name: "edit", input: {} },
        { id: "3", name: finish.name, input: { summary: "done" } },
      ],
    },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "edit" }],
    tools,
    maxTurns: 4,
  });

  const pass =
    result.stopReason === "finish_tool" &&
    isSuccessfulStop(result.stopReason) &&
    result.turns === 1 &&
    order.join(",") === "inspect,edit";

  return summarize("A.read_mutate_finish", result, order, pass, order.join(","));
}

/** B. multiple independent reads run successfully. */
export async function scenarioMultipleReads(): Promise<EvalScenarioResult> {
  let active = 0;
  let maxActive = 0;
  const toolNames: string[] = [];
  const tools: AgentToolSet = {
    read_a: defineTool({
      kind: "read",
      description: "a",
      inputSchema: emptySchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        toolNames.push("read_a");
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { ok: true };
      },
    }),
    read_b: defineTool({
      kind: "read",
      description: "b",
      inputSchema: emptySchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        toolNames.push("read_b");
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { ok: true };
      },
    }),
  };

  const finish = createFinishTool();
  tools[finish.name] = finish.tool;

  const model = scriptedModel([
    {
      kind: "tools",
      calls: [
        { id: "1", name: "read_a", input: {} },
        { id: "2", name: "read_b", input: {} },
        { id: "3", name: finish.name, input: { summary: "ok" } },
      ],
    },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "read" }],
    tools,
  });

  const pass =
    result.stopReason === "finish_tool" &&
    toolNames.sort().join(",") === "read_a,read_b" &&
    maxActive === 2;

  return summarize(
    "B.multiple_reads",
    result,
    toolNames,
    pass,
    `maxActive=${maxActive}`,
  );
}

/** C. mutations execute sequentially. */
export async function scenarioSequentialMutations(): Promise<EvalScenarioResult> {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const tools: AgentToolSet = {
    m1: defineTool({
      kind: "mutate",
      description: "m1",
      inputSchema: emptySchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push("m1");
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return { ok: true };
      },
    }),
    m2: defineTool({
      kind: "mutate",
      description: "m2",
      inputSchema: emptySchema,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push("m2");
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return { ok: true };
      },
    }),
  };
  const finish = createFinishTool();
  tools[finish.name] = finish.tool;

  const model = scriptedModel([
    {
      kind: "tools",
      calls: [
        { id: "1", name: "m1", input: {} },
        { id: "2", name: "m2", input: {} },
        { id: "3", name: finish.name, input: { summary: "ok" } },
      ],
    },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "mutate" }],
    tools,
  });

  const pass =
    result.stopReason === "finish_tool" &&
    order.join(",") === "m1,m2" &&
    maxActive === 1;

  return summarize(
    "C.sequential_mutations",
    result,
    order,
    pass,
    `maxActive=${maxActive}`,
  );
}

/** D. repeated identical failing mutation is fused. */
export async function scenarioFailureFuse(): Promise<EvalScenarioResult> {
  let executes = 0;
  const tools: AgentToolSet = {
    bad: defineTool({
      kind: "mutate",
      description: "bad",
      inputSchema: nSchema,
      execute: async () => {
        executes += 1;
        return { ok: false, reasonCode: "NOPE" };
      },
    }),
  };

  const model = scriptedModel([
    { kind: "tools", calls: [{ id: "1", name: "bad", input: { n: 1 } }] },
    { kind: "tools", calls: [{ id: "2", name: "bad", input: { n: 1 } }] },
    { kind: "tools", calls: [{ id: "3", name: "bad", input: { n: 1 } }] },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "retry" }],
    tools,
    maxTurns: 3,
    maxAttemptsPerCall: 2,
  });

  const pass =
    result.stopReason === "max_turns" &&
    !isSuccessfulStop(result.stopReason) &&
    executes === 2;

  return summarize(
    "D.failure_fuse",
    result,
    Array.from({ length: executes }, () => "bad"),
    pass,
    `executes=${executes}`,
  );
}

/** E. max_turns is not successful. */
export async function scenarioMaxTurns(): Promise<EvalScenarioResult> {
  const tools: AgentToolSet = {
    poke: defineTool({
      kind: "read",
      description: "poke",
      inputSchema: emptySchema,
      execute: async () => ({ ok: true }),
    }),
  };

  const model = scriptedModel([
    { kind: "tools", calls: [{ id: "1", name: "poke", input: {} }] },
    { kind: "tools", calls: [{ id: "2", name: "poke", input: {} }] },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "loop" }],
    tools,
    maxTurns: 2,
  });

  const pass =
    result.stopReason === "max_turns" && !isSuccessfulStop(result.stopReason);

  return summarize("E.max_turns", result, ["poke", "poke"], pass);
}

/** F. deadline is not successful. */
export async function scenarioDeadline(): Promise<EvalScenarioResult> {
  const tools: AgentToolSet = {
    slow: defineTool({
      kind: "read",
      description: "slow",
      inputSchema: emptySchema,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
    }),
  };

  const model = scriptedModel([
    { kind: "tools", calls: [{ id: "1", name: "slow", input: {} }] },
    { kind: "tools", calls: [{ id: "2", name: "slow", input: {} }] },
    { kind: "text", text: "should not reach" },
  ]);

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "hurry" }],
    tools,
    maxTurns: 10,
    deadlineMs: 1,
  });

  const pass =
    result.stopReason === "deadline" && !isSuccessfulStop(result.stopReason);

  return summarize("F.deadline", result, [], pass);
}

export const ALL_SCENARIOS = [
  scenarioReadMutateFinish,
  scenarioMultipleReads,
  scenarioSequentialMutations,
  scenarioFailureFuse,
  scenarioMaxTurns,
  scenarioDeadline,
] as const;
