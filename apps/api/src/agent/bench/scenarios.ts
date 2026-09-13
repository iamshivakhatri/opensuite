import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentResult,
  BenchmarkRunRecord,
  DocumentRef,
  DocumentRuntime,
} from "@opensuite/agent-core";
import { buildDocxBody, buildMinimalDocx } from "@opensuite/engine-client";

import type { BenchHarness } from "./harness.js";

export interface BenchScenario {
  readonly id: string;
  readonly label: string;
  readonly instruction: string;
  /** When null, greenfield (no primary — create tool only until blank create). */
  readonly seed: (harness: BenchHarness) => DocumentRef | null;
  readonly check: (ctx: {
    readonly result: AgentResult;
    readonly toolNames: readonly string[];
    readonly events: readonly AgentEvent[];
    readonly document: DocumentRef | null;
    readonly runtime: DocumentRuntime;
  }) => { ok: boolean; notes: string[] } | Promise<{ ok: boolean; notes: string[] }>;
}

const SECOND_PARAGRAPH =
  "Reading regularly builds knowledge and reduces stress over time.";

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  {
    id: "target-duplicate",
    label: "G. Duplicate paragraph target",
    instruction: "Apply bold text formatting only to the second body paragraph whose exact text is 'Note'. A table cell has the same text. Inspect narrowly if needed.",
    seed(harness) {
      return harness.seedDocument(
        buildDocxBody([
          { kind: "table", rows: [["Label"], ["Note"]] },
          { kind: "paragraph", text: "Title" },
          { kind: "paragraph", text: "Note" },
          { kind: "paragraph", text: "Note" },
          { kind: "paragraph", text: "Closing" },
        ]),
      );
    },
    check({ result, events }) {
      const notes: string[] = [];
      const correctBodyTarget = events.some((event) =>
        event.type === "tool.started" &&
        event.toolName === "document.set_text_formatting" &&
        (event.input as { target?: { text?: unknown; occurrence?: unknown }; bold?: unknown } | undefined)?.target?.text === "Note" &&
        (event.input as { target?: { occurrence?: unknown } } | undefined)?.target?.occurrence === 2 &&
        (event.input as { bold?: unknown } | undefined)?.bold === true,
      );
      if (!correctBodyTarget) notes.push("expected bold formatting for body Note occurrence 2");
      if (result.toolOutcomes.some((o) => o.diagnostic?.code === "TARGET_AMBIGUOUS")) notes.push("normal path must avoid TARGET_AMBIGUOUS");
      if (result.toolOutcomes.some((o) => o.toolName === "document.set_text_formatting" && o.status !== "succeeded")) notes.push("text formatting mutation failed");
      if (result.status !== "completed") notes.push(`run status=${result.status}`);
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "target-recovery",
    label: "H. Target ambiguity recovery",
    instruction: "Make the body paragraph 'Note' immediately before 'Closing' use Heading 1. There are two body paragraphs named 'Note'; inspect the document as needed to identify the correct one.",
    seed(harness) {
      return harness.seedDocument(buildMinimalDocx(["Title", "Note", "Note", "Closing"]));
    },
    check({ result, toolNames, events }) {
      const notes: string[] = [];
      const correctedTarget = events.some((event) =>
        event.type === "tool.started" &&
        event.toolName === "document.set_paragraph_style" &&
        (event.input as { target?: { text?: unknown; occurrence?: unknown }; style?: unknown } | undefined)?.target?.text === "Note" &&
        (event.input as { target?: { occurrence?: unknown } } | undefined)?.target?.occurrence === 2 &&
        (event.input as { style?: unknown } | undefined)?.style === "Heading 1",
      );
      if (!correctedTarget) notes.push("expected Heading 1 for the body Note before Closing");
      if (!toolNames.includes("document.inspect")) notes.push("expected focused inspection for duplicate body paragraphs");
      if (result.toolOutcomes.some((o) => o.toolName === "document.set_paragraph_style" && o.status !== "succeeded" && o.diagnostic?.code !== "TARGET_AMBIGUOUS")) notes.push("paragraph style mutation failed");
      if (result.status !== "completed") notes.push(`run status=${result.status}`);
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "simple-read",
    label: "A. Simple read",
    instruction: "What does the second paragraph say?",
    seed(harness) {
      return harness.seedDocument(
        buildMinimalDocx([
          "Reading Plan",
          SECOND_PARAGRAPH,
          "Schedule time each morning for focused reading.",
        ]),
      );
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      const inspected =
        toolNames.includes("document.inspect") ||
        toolNames.includes("document.find");
      if (!inspected) notes.push("expected inspect or find before answer");
      if (toolNames.includes("workspace.create_blank_docx")) {
        notes.push("must not create blank on existing-doc read");
      }
      const answered =
        result.status === "completed" &&
        /reading|knowledge|stress|regularly/i.test(result.summary);
      if (!answered) notes.push("answer missing second-paragraph content");
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "simple-edit",
    label: "B. Simple edit",
    instruction: "Make the title Heading 1.",
    seed(harness) {
      return harness.seedDocument(
        buildMinimalDocx([
          "Quarterly Update",
          "Body paragraph about the quarter.",
        ]),
      );
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (toolNames.includes("workspace.create_blank_docx")) {
        notes.push("must not create blank on existing-doc edit");
      }
      if (!toolNames.includes("document.set_paragraph_style")) {
        notes.push("expected document.set_paragraph_style");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "greenfield-small",
    label: "C. Greenfield small authoring",
    instruction:
      "Create a new DOCX named Small Report with a title, two short paragraphs, a small 3x3 table, and a one-sentence conclusion. Prefer batched writes.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (toolNames.includes("document.capabilities")) {
        notes.push("must not call document.capabilities");
      }
      const wrote =
        toolNames.includes("document.insert_paragraphs") ||
        toolNames.includes("document.insert_paragraph") ||
        toolNames.includes("document.create_table");
      if (!wrote) notes.push("expected authoring writes after create");
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "greenfield-large",
    label: "D. Greenfield larger structured authoring",
    instruction:
      "Create a new useful content plan DOCX with: an introduction paragraph, a 10-row table (header + 9 data rows) with columns Topic, Owner, Status, and a short conclusion. Prefer batched writes in few model turns.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (!toolNames.includes("document.create_table")) {
        notes.push("expected document.create_table for structured content");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "greenfield-poems",
    label: "F. Greenfield poems and formatting",
    instruction:
      "Create a new DOCX with a title, a short introduction, five short poems with headings, readable formatting, and a closing section. Prefer batched writes in few model turns.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (!toolNames.includes("document.insert_paragraphs")) {
        notes.push("expected batched poem authoring");
      }
      if (!toolNames.includes("document.set_paragraph_style")) {
        notes.push("expected title or heading formatting");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "reason-mutate",
    label: "E. Existing-document reasoning + mutation",
    instruction:
      "Find the Revenue section, add a short paragraph after it noting that Q4 outlook is strong, and change the Revenue table cell for Product A Q3 from 120 to 135.",
    seed(harness) {
      return harness.seedDocument(
        buildDocxBody([
          { kind: "paragraph", text: "Company Brief" },
          { kind: "paragraph", text: "Overview of performance." },
          { kind: "paragraph", text: "Revenue" },
          {
            kind: "table",
            rows: [
              ["Product", "Q2", "Q3"],
              ["Product A", "100", "120"],
              ["Product B", "80", "90"],
            ],
          },
          { kind: "paragraph", text: "End of brief." },
        ]),
      );
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (toolNames.includes("workspace.create_blank_docx")) {
        notes.push("must not create blank on existing-doc mutation");
      }
      const inspected =
        toolNames.includes("document.inspect") ||
        toolNames.includes("document.find");
      if (!inspected) notes.push("expected inspect/find to locate Revenue");
      const mutated =
        toolNames.includes("document.insert_paragraph") ||
        toolNames.includes("document.insert_paragraphs") ||
        toolNames.includes("document.set_table_cells_text") ||
        toolNames.includes("document.replace_text");
      if (!mutated) notes.push("expected dependent writes after locate");
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "authoring-memo",
    label: "I. Authoring quality — professional memo",
    instruction:
      "Create a new short business memo with a title, To/From/Subject lines, two body paragraphs, and sensible hierarchy/spacing. Prefer batched writes; do not ritual-inspect.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (!toolNames.includes("document.insert_paragraphs") && !toolNames.includes("document.insert_paragraph")) {
        notes.push("expected paragraph authoring");
      }
      if (!toolNames.includes("document.set_paragraph_style")) {
        notes.push("expected hierarchy via paragraph styles");
      }
      if (toolNames.includes("document.create_table")) {
        notes.push("memo should not use a table for layout");
      }
      if (toolNames.filter((n) => n === "document.inspect").length > 1) {
        notes.push("avoid inspect repair loops");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "authoring-guide",
    label: "J. Authoring quality — hierarchical guide",
    instruction:
      "Create a new onboarding guide with a title, Overview section, Setup steps as a short bullet list, and Tips. Use styles for hierarchy and list formatting for steps. Prefer batched writes.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (!toolNames.includes("document.set_paragraph_style")) {
        notes.push("expected heading hierarchy");
      }
      if (!toolNames.includes("document.set_paragraphs_list")) {
        notes.push("expected list formatting for setup steps");
      }
      if (toolNames.includes("document.create_table")) {
        notes.push("guide steps should be a list, not a table");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "authoring-creative",
    label: "K. Authoring quality — short creative pieces",
    instruction:
      "Create a new short document with a title and two titled pieces made of a few tightly related lines each. Use heading styles and tighter spacing for related lines. Prefer batched writes; do not fake layout with punctuation separators.",
    seed() {
      return null;
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) {
        notes.push("expected workspace.create_blank_docx");
      }
      if (!toolNames.includes("document.insert_paragraphs")) {
        notes.push("expected batched semantic inserts");
      }
      if (!toolNames.includes("document.set_paragraph_style")) {
        notes.push("expected hierarchy via styles");
      }
      if (!toolNames.includes("document.set_paragraph_formatting")) {
        notes.push("expected deliberate spacing for related lines");
      }
      if (toolNames.includes("document.create_table")) {
        notes.push("creative pieces should not use a table for layout");
      }
      if (result.status !== "completed") {
        notes.push(`run status=${result.status}`);
      }
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "launch-brief",
    label: "L. Complex Product Launch Readiness Brief",
    instruction:
      "Create a new Product Launch Readiness Brief for a fictional SaaS product with a title, executive summary, Product, Engineering, Marketing, Support, and Risks sections, a readiness table, a prioritized checklist, and a final recommendation. Use professional semantic formatting, sensible page layout, and page numbers if supported.",
    seed() {
      return null;
    },
    async check({ result, toolNames, document, runtime }) {
      const notes: string[] = [];
      if (!toolNames.includes("workspace.create_blank_docx")) notes.push("expected a new document");
      if (result.status !== "completed") notes.push(`run status=${result.status}`);
      if (result.toolOutcomes.some((outcome) => outcome.status === "failed")) notes.push("unresolved failed tool state");
      if (!document) return { ok: false, notes: [...notes, "missing final document"] };

      const [paragraphInspection, headingInspection, tableInspection] = await Promise.all([
        runtime.inspect(document, { focus: { kind: "paragraphs", offset: 0, limit: 100 } }),
        runtime.inspect(document, { focus: { kind: "headings", offset: 0, limit: 100 } }),
        runtime.inspect(document, { focus: { kind: "tables", offset: 0, limit: 20 } }),
      ]);
      if (paragraphInspection.status !== "success" || headingInspection.status !== "success" || tableInspection.status !== "success") {
        return { ok: false, notes: [...notes, "could not inspect completed document"] };
      }
      if (paragraphInspection.payload.format !== "docx" || headingInspection.payload.format !== "docx" || tableInspection.payload.format !== "docx") {
        return { ok: false, notes: [...notes, "completed document is not DOCX"] };
      }

      const paragraphText = paragraphInspection.payload.paragraphs?.map((paragraph) => paragraph.text).join("\n") ?? "";
      for (const required of ["executive summary", "product", "engineering", "marketing", "support", "risks", "checklist", "recommendation"]) {
        if (!paragraphText.toLowerCase().includes(required)) notes.push(`missing ${required} content`);
      }
      if ((headingInspection.payload.headings?.length ?? 0) < 3) notes.push("expected reasonable heading hierarchy");
      const tables = tableInspection.payload.tables ?? [];
      if (!tables.some((table) => table.rowCount >= 2 && table.cols >= 2)) notes.push("missing readiness table");
      return { ok: notes.length === 0, notes };
    },
  },
];

export function scenarioById(id: string): BenchScenario | undefined {
  return BENCH_SCENARIOS.find((s) => s.id === id);
}

export function selectScenarios(
  filter: string | undefined,
): readonly BenchScenario[] {
  if (!filter || filter.trim() === "" || filter.trim() === "all") {
    return BENCH_SCENARIOS;
  }
  const ids = filter.split(/[,+\s]+/).map((s) => s.trim()).filter(Boolean);
  const selected = ids
    .map((id) => {
      const byId = scenarioById(id);
      if (byId) return byId;
      // Allow A/B/C aliases
      const letter = id.toUpperCase();
      const map: Record<string, string> = {
        A: "simple-read",
        B: "simple-edit",
        C: "greenfield-small",
        D: "greenfield-large",
        E: "reason-mutate",
        F: "greenfield-poems",
        I: "authoring-memo",
        J: "authoring-guide",
        K: "authoring-creative",
        L: "launch-brief",
      };
      return scenarioById(map[letter] ?? id);
    })
    .filter((s): s is BenchScenario => s != null);
  if (selected.length === 0) {
    throw new Error(
      `No scenarios matched SCENARIO=${filter}. Valid: ${BENCH_SCENARIOS.map((s) => s.id).join(", ")}`,
    );
  }
  return selected;
}

export function freshRunId(scenarioId: string): string {
  return `bench-${scenarioId}-${randomUUID().slice(0, 8)}`;
}

export type { BenchmarkRunRecord };
