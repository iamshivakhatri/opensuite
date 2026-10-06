import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool } from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";
import { CapabilityRegistry, type CapabilityDefinition } from "./registry.js";
import { CapabilitySession } from "./session.js";
import { capabilityRegistry } from "../catalog.js";
import { projectLoadedInstructions } from "../runtime/instruction-projection.js";
import { createCalculatorTool } from "../definitions/compute/calculator.js";

const group = (id: string, parentId: string | null): CapabilityDefinition => ({ id, parentId, kind: "group", title: id, description: `Find ${id}`, projection: "dynamic" });
const tool = (id: string, parentId: string): CapabilityDefinition => ({ id, parentId, kind: "tool", title: id, description: `Use ${id}`, projection: "dynamic", toolName: id });

test("registry rejects duplicate IDs, missing parents, cycles, and provider-name collisions", () => {
  assert.throws(() => new CapabilityRegistry([group("a", null), group("a", null)]), /Duplicate capability ID/);
  assert.throws(() => new CapabilityRegistry([group("a", "missing")]), /Missing parent/);
  assert.throws(() => new CapabilityRegistry([group("a", "b"), group("b", "a")]), /cycle/i);
  assert.throws(() => new CapabilityRegistry([group("root", null), tool("a.b", "root"), tool("a_b", "root")]), /Conflicting provider tool name/);
  assert.throws(() => new CapabilityRegistry([group("root", null), { id: "root.bad", parentId: "root", kind: "instruction", title: "Bad", description: "Bad", projection: "always", instructions: () => "Bad" }]), /dynamically/);
  assert.throws(() => new CapabilityRegistry([group("root", null), {
    id: "root.skill", parentId: "root", kind: "instruction", title: "Skill", description: "Skill", projection: "dynamic",
    companionCapabilities: ["root.missing"], instructions: () => "Skill",
  }]), /Invalid companion capability/);
});

test("indexed root, child, and lexical search return bounded metadata", () => {
  const registry = new CapabilityRegistry([group("root", null), group("root.child", "root"), tool("root.child.edit", "root.child")]);
  assert.deepEqual(registry.roots().map((item) => item.id), ["root"]);
  assert.deepEqual(registry.children("root").map((item) => item.id), ["root.child"]);
  assert.deepEqual(registry.search("edit").map((item) => item.id), ["root.child.edit"]);
});

test("search ranks a title match ahead of a description-only match", () => {
  const registry = new CapabilityRegistry([group("root", null),
    { ...tool("root.other", "root"), description: "Edit a file" },
    { ...tool("root.edit", "root"), title: "Edit" },
  ]);
  assert.deepEqual(registry.search("edit").slice(0, 2).map((item) => item.id), ["root.edit", "root.other"]);
});

test("instruction bodies are resolved on load and share a session with executable tools", () => {
  let reads = 0;
  const definitions: CapabilityDefinition[] = [group("root", null),
    { id: "root.skill", parentId: "root", kind: "instruction", title: "Skill", description: "Write", projection: "dynamic", instructions: () => { reads++; return "Unique guidance"; } },
    tool("root.edit", "root")];
  const registry = new CapabilityRegistry(definitions);
  const tools = { "root.edit": defineTool({ kind: "read", description: "Edit", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) }) };
  const session = new CapabilitySession(registry, tools);
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(session.projectTools()), []);
  assert.deepEqual(session.load(["root.skill", "root.edit"]).loadedIds, ["root.edit", "root.skill"]);
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(session.projectTools()), ["root.edit"]);
  assert.match(String(projectLoadedInstructions(session)?.message.content), /Unique guidance/);
  session.load(["root.skill"]);
  assert.equal(reads, 1);
});

test("prompt recommendations are bounded, available, and metadata-only", () => {
  const session = new CapabilitySession(capabilityRegistry, { "compute.calculator": createCalculatorTool() });
  assert.deepEqual(session.recommend("Calculate the compound annual growth rate from 4.2M to 6.8M over 3 years").map((item) => item.id), ["compute.calculator"]);
  assert.deepEqual(session.recommend("Write a scientific paper about the supplied experiment").map((item) => item.id), ["skills.scientific-writing.scientific-paper"]);
  assert.deepEqual(session.recommend("Update this document's heading").map((item) => item.id), []);
  const recommendation = JSON.stringify(session.recommend("scientific paper"));
  assert.doesNotMatch(recommendation, /Never invent|inputSchema|instructions/);
  assert.equal(session.projectTools()["compute.calculator"], undefined);
  assert.ok(session.list("compute").ok);
  assert.ok(session.search("calculator").capabilities.length > 0);
});

test("large catalog keeps root listing fixed and one loaded leaf isolated", () => {
  const definitions: CapabilityDefinition[] = [group("root", null)];
  const tools: Record<string, ReturnType<typeof defineTool>> = {};
  const inputSchema = jsonSchema({ type: "object", properties: {} });
  for (let index = 0; index < 10_000; index++) {
    const id = `root.item${index}`;
    definitions.push(tool(id, "root"));
    tools[id] = defineTool({ kind: "read", description: id, inputSchema, execute: () => ({ ok: true }) });
  }
  const registry = new CapabilityRegistry(definitions);
  const session = new CapabilitySession(registry, tools);
  assert.deepEqual(session.roots().map((item) => item.id), ["root"]);
  const rootIndex = session.roots().map((item) => `${item.id}: ${item.description}`).join("\n");
  assert.ok(rootIndex.length < 100);
  assert.equal(rootIndex.includes("item9999"), false);
  assert.equal(registry.children("root").length, 10_000);
  assert.deepEqual(Object.keys(session.projectTools()), []);
  assert.deepEqual(session.load(["root.item9999"]), { ok: true, loadedIds: ["root.item9999"] });
  assert.deepEqual(Object.keys(session.projectTools()), ["root.item9999"]);
});

test("thousands of unloaded skills add no body or root prompt cost", () => {
  let bodyReads = 0;
  const definitions: CapabilityDefinition[] = [group("skills", null), group("skills.writing", "skills")];
  for (let index = 0; index < 2_000; index++) definitions.push({
    id: `skills.writing.item${index}`, parentId: "skills.writing", kind: "instruction",
    title: `Writing skill ${index}`, description: `Write item ${index}`, projection: "dynamic",
    instructions: () => { bodyReads++; return `Large private body ${index} ${"x".repeat(1_000)}`; },
  });
  const session = new CapabilitySession(new CapabilityRegistry(definitions), {});
  assert.ok(JSON.stringify(session.roots()).length < 150);
  assert.equal(projectLoadedInstructions(session), undefined);
  assert.equal(bodyReads, 0);
  session.load(["skills.writing.item1999"]);
  assert.equal(bodyReads, 1);
  const guidance = String(projectLoadedInstructions(session)?.message.content);
  assert.match(guidance, /Large private body 1999/);
  assert.doesNotMatch(guidance, /Large private body 1998/);
});

test("large registry keeps prompt recommendations and root context bounded", () => {
  const definitions: CapabilityDefinition[] = [group("skills", null), group("skills.writing", "skills")];
  for (let index = 0; index < 20_000; index++) definitions.push({
    id: `skills.writing.unrelated${index}`, parentId: "skills.writing", kind: "instruction",
    title: `Unrelated topic ${index}`, description: "Unrelated guidance", projection: "dynamic",
    instructions: () => "Private body",
  });
  definitions.push({ id: "skills.writing.paper", parentId: "skills.writing", kind: "instruction",
    title: "Scientific paper", description: "Research paper writing", projection: "dynamic", instructions: () => "Private paper body" });
  const session = new CapabilitySession(new CapabilityRegistry(definitions), {});
  assert.ok(JSON.stringify(session.roots()).length < 150);
  const matches = session.recommend("Write a scientific paper");
  assert.deepEqual(matches.map((item) => item.id), ["skills.writing.paper"]);
  assert.ok(matches.length <= 3);
  assert.doesNotMatch(JSON.stringify(matches), /Private paper body/);
});
