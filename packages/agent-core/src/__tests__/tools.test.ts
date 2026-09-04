import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  Capabilities,
  ToolRegistry,
  createCapabilities,
  createFakeTool,
  createFakeToolExecutionContext,
  hasCapability,
  listCapabilities,
  requiresConfirmation,
} from "../index.js";

test("ToolRegistry registers, retrieves, and lists tools deterministically", () => {
  const beta = createFakeTool({
    name: "document.replace_text",
    execute: async () => ({ ok: true }),
  });
  const alpha = createFakeTool({
    name: "document.inspect",
    execute: async () => ({ ok: true }),
  });

  const registry = ToolRegistry.create([beta, alpha]);
  assert.equal(registry.size, 2);
  assert.equal(registry.get("document.inspect"), alpha);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["document.inspect", "document.replace_text"],
  );
  assert.deepEqual(
    registry.definitions().map((definition) => definition.name),
    ["document.inspect", "document.replace_text"],
  );
});

test("ToolRegistry rejects duplicate names", () => {
  const tool = createFakeTool({
    name: "document.inspect",
    execute: async () => null,
  });
  assert.throws(
    () => ToolRegistry.create([tool, tool]),
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "DUPLICATE_TOOL_NAME",
  );
});

test("capabilities support check and unknown capability is false", () => {
  const caps = createCapabilities(Capabilities.DocumentInspect);
  assert.equal(hasCapability(caps, Capabilities.DocumentInspect), true);
  assert.equal(hasCapability(caps, Capabilities.DocumentMutate), false);
  assert.equal(hasCapability(caps, "workbook.cells.write"), false);
  assert.deepEqual(listCapabilities(caps), [Capabilities.DocumentInspect]);
});

test("policy metadata distinguishes safe vs destructive tools", () => {
  const safe = createFakeTool({
    name: "document.replace_text",
    risk: "safe",
    execute: async () => null,
  });
  const destructive = createFakeTool({
    name: "slides.delete_slide",
    risk: "destructive",
    execute: async () => null,
  });
  assert.equal(requiresConfirmation(safe), false);
  assert.equal(requiresConfirmation(destructive), true);
});

test("fake tool typed execution accepts AbortSignal", async () => {
  const controller = new AbortController();
  const seen: boolean[] = [];

  const tool = createFakeTool<{ q: string }, { answer: string }>({
    name: "research.web_search",
    parseInput(raw) {
      assert.ok(raw && typeof raw === "object");
      return raw as { q: string };
    },
    async execute(input, ctx) {
      seen.push(ctx.signal.aborted);
      return { answer: `result:${input.q}` };
    },
  });

  const result = await tool.execute(
    tool.parseInput({ q: "FY2026" }),
    createFakeToolExecutionContext({ signal: controller.signal }),
  );
  assert.deepEqual(result, { answer: "result:FY2026" });
  assert.deepEqual(seen, [false]);

  controller.abort();
  await tool.execute(
    { q: "x" },
    createFakeToolExecutionContext({ signal: controller.signal }),
  );
  assert.deepEqual(seen, [false, true]);
});
