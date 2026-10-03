import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool } from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";
import { CapabilityRegistry, type CapabilityDefinition } from "./registry.js";
import { CapabilitySession } from "./session.js";
import { capabilityRegistry } from "./catalog.js";
import { projectLoadedInstructions } from "./instruction-projection.js";

const group = (id: string, parentId: string | null): CapabilityDefinition => ({ id, parentId, kind: "group", title: id, description: `Find ${id}`, projection: "dynamic" });
const tool = (id: string, parentId: string): CapabilityDefinition => ({ id, parentId, kind: "tool", title: id, description: `Use ${id}`, projection: "dynamic", toolName: id });

test("registry rejects duplicate IDs, missing parents, cycles, and provider-name collisions", () => {
  assert.throws(() => new CapabilityRegistry([group("a", null), group("a", null)]), /Duplicate capability ID/);
  assert.throws(() => new CapabilityRegistry([group("a", "missing")]), /Missing parent/);
  assert.throws(() => new CapabilityRegistry([group("a", "b"), group("b", "a")]), /cycle/i);
  assert.throws(() => new CapabilityRegistry([group("root", null), tool("a.b", "root"), tool("a_b", "root")]), /Conflicting provider tool name/);
  assert.throws(() => new CapabilityRegistry([group("root", null), { id: "root.bad", parentId: "root", kind: "instruction", title: "Bad", description: "Bad", projection: "always", instructions: () => "Bad" }]), /dynamically/);
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

test("scientific paper skill is discoverable as metadata and loads guidance without a tool", () => {
  const events: { capabilityId: string; kind: string; type: string }[] = [];
  const session = new CapabilitySession(capabilityRegistry, {}, (event) => { events.push(event); });
  const id = "skills.scientific-writing.scientific-paper";
  assert.deepEqual(session.roots().map((item) => item.id), ["skills"]);
  assert.deepEqual(session.list("skills").capabilities?.map((item) => item.id), ["skills.scientific-writing"]);
  assert.deepEqual(session.list("skills.scientific-writing").capabilities?.map((item) => item.id), [id]);
  assert.deepEqual(session.search("write a research paper").capabilities.map((item) => item.id), [id]);
  assert.doesNotMatch(JSON.stringify(session.search("scientific paper")), /Never invent methods/);
  assert.equal(projectLoadedInstructions(session), undefined);
  assert.deepEqual(session.load([id], 1), { ok: true, loadedIds: [id] });
  const guidance = projectLoadedInstructions(session);
  assert.match(String(guidance?.message.content), /Never invent methods/);
  const limited = projectLoadedInstructions(session, 80);
  assert.ok(limited && limited.estimatedTokens <= 80);
  assert.ok(limited.estimatedTokens < guidance!.estimatedTokens);
  assert.equal(Object.keys(session.projectTools()).length, 0);
  assert.deepEqual(session.load([id], 2), { ok: true, loadedIds: [id] });
  assert.equal(events.filter((event) => event.type === "loaded").length, 1);
  assert.ok(events.some((event) => event.capabilityId === id && event.kind === "instruction" && event.type === "discovered"));
  assert.equal(events.some((event) => event.type === "executed" || event.type === "succeeded"), false);
  assert.equal(projectLoadedInstructions(new CapabilitySession(capabilityRegistry, {})), undefined);
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
