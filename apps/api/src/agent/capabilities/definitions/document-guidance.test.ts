import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool, runAgent } from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { capabilityRegistry } from "../catalog.js";
import { CapabilitySession, type CapabilityEvent } from "../core/session.js";
import { documentSkillPolicy } from './skills/index.js';
import { projectLoadedInstructions } from "../runtime/instruction-projection.js";
import { createToolSurface } from "../runtime/tool-surface.js";

const skills = [
  "skills.reporting.analytical-report", "skills.reporting.recurring-update",
  "skills.coordination.meeting-minutes", "skills.correspondence.executive-memo",
  "skills.correspondence.professional-letter", "skills.proposals.basic-proposal",
  "skills.career.resume", "skills.procedures.sop",
];
const styles = [
  "styles.reporting.professional", "styles.correspondence.executive",
  "styles.proposals.professional", "styles.career.clean-resume",
  "styles.procedures.controlled-sop",
];
const dogfoodResumePrompt = `Create a clean professional resume from these facts:

Name: Maya Chen
Role: Software Engineer

Experience:
- Software Engineer, Northstar Labs, 2023–2026
- Built internal developer tools
- Reduced CI runtime from 28 minutes to 11 minutes
- Led migration of 14 services to a shared deployment platform

Education:
BS Computer Science, University of Washington, 2023

Skills:
TypeScript, Rust, PostgreSQL, AWS

Use an appropriate resume skill and visual style.
Do not invent any experience, dates, metrics, education, or skills.`;

const dogfoodReportPrompt = `Create a professional quarterly operating report for Cincinnati Sports Club.

Reporting period: Q3 2026

Metrics:
- Revenue: $3.8M
- Active members: 4,250
- Member retention: 91%
- Personal training revenue: $420K
- Group fitness participation: 1,180 members
- Member satisfaction: 94%

Include a title, executive summary, Key Performance Indicators section, two-column KPI table, and Operational Highlights section.`;

test("document skills and style packs register as lazy instructions with a bounded root", () => {
  const session = new CapabilitySession(capabilityRegistry, {});
  for (const id of [...skills, ...styles]) {
    const definition = capabilityRegistry.get(id);
    assert.equal(definition?.kind, "instruction", id);
    assert.equal(definition.projection, "dynamic", id);
    assert.equal(typeof definition.instructions, "function", id);
    assert.equal(definition.parentId, id.slice(0, id.lastIndexOf(".")), id);
  }
  assert.deepEqual(session.roots().map((item) => item.id), ["skills", "styles"]);
  assert.ok(JSON.stringify(session.roots()).length < 300);
  assert.deepEqual(session.projectInstructions(), []);
  assert.equal(projectLoadedInstructions(session), undefined);
  assert.doesNotMatch(JSON.stringify(session.recommend("Create a monthly operating report")), /Build a report around|Style a new/);
});

test("obvious requests recommend the matching document skill and style", () => {
  const session = new CapabilitySession(capabilityRegistry, {});
  const cases: readonly [string, readonly string[]][] = [
    ["Create a monthly operating report", [skills[0]!, styles[0]!]],
    ["Create a professional report", [skills[0]!, styles[0]!]],
    ["Update this monthly report using April figures", [skills[1]!, styles[0]!]],
    ["Turn these notes into meeting minutes", [skills[2]!]],
    ["Draft an executive memo about the decision", [skills[3]!, styles[1]!]],
    ["Write a professional letter to the client", [skills[4]!, styles[1]!]],
    ["Prepare a project proposal from these notes", [skills[5]!, styles[2]!]],
    ["Create a resume from my work history", [skills[6]!, styles[3]!]],
    ["Write an SOP for this process", [skills[7]!, styles[4]!]],
    ["Write a scientific paper about the experiment", ["skills.scientific-writing.scientific-paper"]],
  ];
  for (const [prompt, expected] of cases) {
    assert.deepEqual(session.recommend(prompt).map((item) => item.id), expected, prompt);
  }
  assert.deepEqual(session.recommend("Rename my document"), []);
  assert.deepEqual([...session.loaded], []);
});

test('quarterly KPI report routing puts the document skill ahead of the generic style pack', () => {
  const session = new CapabilitySession(capabilityRegistry, {});
  const recommendations = session.recommend(dogfoodReportPrompt).map((item) => item.id);
  assert.equal(recommendations[0], skills[0]);
  const styleIndex = recommendations.indexOf(styles[0]!);
  assert.ok(styleIndex === -1 || styleIndex > 0);
  for (const prompt of ['Create a quarterly operating report', 'Create an operating report', 'Create a KPI report', 'Create a professional report with metrics']) {
    assert.equal(session.recommend(prompt)[0]?.id, skills[0], prompt);
  }
  assert.equal(session.load([skills[0]!]).ok, true);
  assert.ok(session.loaded.has(skills[0]!));
  assert.equal(session.loaded.has(styles[0]!), false);
  assert.deepEqual(documentSkillPolicy(skills[0]!)?.channels, ['typography', 'colors', 'tableAccent']);
});

test("dogfood resume prompt recommends exact loadable guidance and available formatting companions", () => {
  const emptySchema = jsonSchema({ type: "object", properties: {} });
  const formatTool = () => defineTool({ kind: "mutate" as const, description: "format", inputSchema: emptySchema, execute: () => ({ ok: true }) });
  const session = new CapabilitySession(capabilityRegistry, {
    "document.set_paragraph_formatting": formatTool(),
    "document.set_paragraphs_list": formatTool(),
    "document.set_text_formatting": formatTool(),
  });
  const recommendations = session.recommend(dogfoodResumePrompt);
  assert.deepEqual(recommendations.map((item) => item.id), [skills[6], styles[3]]);
  const companionIds = [...new Set(recommendations.flatMap((item) => item.companionCapabilities ?? []).map((item) => item.id))];
  assert.deepEqual(companionIds, ["document.paragraphs", "document.text"]);
  const recommendedIds = [...recommendations.map((item) => item.id), ...companionIds];
  assert.equal(session.load(recommendedIds).ok, true);
  assert.deepEqual([...session.loaded].sort(), [...recommendedIds].sort());
});

test("unavailable optional companions are omitted without hiding the instruction", () => {
  const session = new CapabilitySession(capabilityRegistry, {
    "document.set_text_formatting": defineTool({ kind: "mutate", description: "format",
      inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) }),
  });
  const recommendations = session.recommend(dogfoodResumePrompt);
  assert.deepEqual(recommendations.map((item) => item.id), [skills[6], styles[3]]);
  assert.deepEqual(recommendations.flatMap((item) => item.companionCapabilities ?? []).map((item) => item.id), ["document.text"]);
  assert.equal(session.load([skills[6]!, styles[3]!, "document.text"]).ok, true);
});

test("skill and style load together and reach only the next model turn", async () => {
  const events: CapabilityEvent[] = [];
  const surface = createToolSurface({ "document.set_text_formatting": defineTool({
    kind: "mutate", description: "Format text", inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: () => ({ ok: true }),
  }) }, (event) => { events.push(event); });
  const ids = ["skills.reporting.analytical-report", "styles.reporting.professional"];
  const loadedIds = [...ids, "document.text"];
  assert.doesNotMatch(surface.capabilityIndex, /Build a report around|Style a new/);
  assert.deepEqual(surface.session.recommend("Create a monthly operating report").map((item) => item.id), ids);
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const prompt = JSON.stringify(options.prompt);
    if (turn === 0) {
      assert.doesNotMatch(prompt, /DOCUMENT SKILL:|STYLE PACK:/);
      assert.equal(options.tools!.some((item) => item.name === "document_set_text_formatting"), false);
    }
    else {
      assert.match(prompt, /DOCUMENT SKILL: Analytical Report/);
      assert.match(prompt, /STYLE PACK: Professional Report Style/);
      assert.match(prompt, /Build a report around/);
      assert.match(prompt, /Style a new/);
      assert.equal((prompt.match(/<loaded_capabilities>/g) ?? []).length, 1);
      assert.equal(options.tools!.some((item) => item.name === "document_set_text_formatting"), true);
    }
    const calls = turn++ === 0 ? [{ type: "tool-call" as const, toolCallId: "load", toolName: "capabilities_load", input: JSON.stringify({ ids: loadedIds }) }] : [];
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, ...calls,
      { type: "finish", finishReason: { unified: calls.length ? "tool-calls" as const : "stop" as const, raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  await runAgent({ model, messages: [{ role: "user", content: "Create a monthly operating report" }],
    tools: surface.tools, projectTools: surface.projectTools,
    projectMessages: (messages) => {
      const guidance = projectLoadedInstructions(surface.session);
      return guidance ? [...messages, guidance.message] : messages;
    }, maxTurns: 2 });
  assert.equal(turn, 2);
  assert.deepEqual([...surface.session.loaded].sort(), loadedIds.sort());
  assert.deepEqual(events.filter((event) => event.type === "loaded" && event.kind === "instruction").map((event) => [event.capabilityId, event.kind]),
    ids.map((id) => [id, "instruction"]));
  assert.deepEqual(events.filter((event) => event.type === "recommended").map((event) => [event.capabilityId, event.kind]),
    [...ids.map((id) => [id, "instruction"]), ["document.text", "group"]]);
  assert.equal(events.some((event) => ["executed", "succeeded"].includes(event.type)), false);
  assert.deepEqual(Object.keys(surface.projectTools()), ["capabilities.list", "capabilities.load", "capabilities.search", "document.set_text_formatting"]);
});

test("style packs use only supported document primitives", () => {
  const unsupported = /\b(?:custom styles?|table of contents|toc|captions?|cross.references?|comments?|tracked changes|footnotes?|endnotes?|charts?|floating images?|text boxes?|signatures?|equations?)\b/i;
  for (const id of styles) {
    const definition = capabilityRegistry.get(id);
    assert.equal(definition?.kind, "instruction");
    assert.doesNotMatch(definition.instructions(), unsupported, id);
    assert.doesNotMatch(definition.instructions(), /set_paragraph_style[^\n]*(?:List Bullet|Resume Bullet|Subtitle)/i, id);
  }
  const resumeStyle = capabilityRegistry.get("styles.career.clean-resume");
  const reportStyle = capabilityRegistry.get("styles.reporting.professional");
  assert.equal(resumeStyle?.kind, "instruction");
  assert.equal(reportStyle?.kind, "instruction");
  assert.match(resumeStyle.instructions(), /set_paragraphs_list using kind "bullet"/);
  assert.match(reportStyle.instructions(), /set_table_cells_formatting to bold header text/);
});
