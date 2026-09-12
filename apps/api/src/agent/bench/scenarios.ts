import { randomUUID } from "node:crypto";

import type {
  AgentResult,
  BenchmarkRunRecord,
  DocumentRef,
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
  }) => { ok: boolean; notes: string[] };
}

const SECOND_PARAGRAPH =
  "Reading regularly builds knowledge and reduces stress over time.";

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  {
    id: "target-duplicate",
    label: "G. Duplicate paragraph target",
    instruction: "Format only the second body paragraph whose exact text is 'Note'. A table cell has the same text. Inspect narrowly if needed, then use occurrence 2.",
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
    check({ result, toolNames }) {
      const notes: string[] = [];
      if (!toolNames.includes("document.set_paragraph_style")) notes.push("expected paragraph style mutation");
      if (result.toolOutcomes.some((o) => o.diagnostic?.code === "TARGET_AMBIGUOUS")) notes.push("normal path must avoid TARGET_AMBIGUOUS");
      if (result.toolOutcomes.some((o) => o.toolName === "document.set_paragraph_style" && o.status !== "succeeded")) notes.push("paragraph style mutation failed");
      if (result.status !== "completed") notes.push(`run status=${result.status}`);
      return { ok: notes.length === 0, notes };
    },
  },
  {
    id: "target-recovery",
    label: "H. Target ambiguity recovery",
    instruction: "If a paragraph style target is ambiguous, inspect only the matching paragraphs, retry once using the returned occurrence, then finish.",
    seed(harness) {
      return harness.seedDocument(buildMinimalDocx(["Title", "Note", "Note", "Closing"]));
    },
    check({ result, toolNames }) {
      const notes: string[] = [];
      const failures = result.toolOutcomes.filter((o) => o.diagnostic?.code === "TARGET_AMBIGUOUS");
      if (failures.length !== 1) notes.push("expected exactly one ambiguous target failure");
      if (!toolNames.includes("document.inspect")) notes.push("expected focused recovery inspection");
      if (!toolNames.includes("document.set_paragraph_style")) notes.push("expected corrected style mutation");
      if (result.toolOutcomes.at(-1)?.status !== "succeeded") notes.push("corrected style mutation failed");
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
