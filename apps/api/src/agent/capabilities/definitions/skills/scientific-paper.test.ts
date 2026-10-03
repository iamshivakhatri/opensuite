import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityRegistry } from "../../catalog.js";
import { CapabilitySession } from "../../core/session.js";
import { projectLoadedInstructions } from "../../runtime/instruction-projection.js";

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
