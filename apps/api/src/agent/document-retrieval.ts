import type {
  DocxEngineBinding,
  DocxInspectBodyBlockItem,
  DocxInspectTableItem,
} from "@opensuite/engine-client";

import { estimateTokens } from "./context-projection.js";

const CACHE_LIMIT = 64;
const PAGE_LIMIT = 100;
const MAX_BLOCKS = 5;
const MAX_TEXT_LENGTH = 240;
const MAX_ARTIFACTS = 3;
const MAX_CATALOG_ARTIFACTS = 10;
/** Initial runtime policy: enough for useful evidence without bloating every turn. */
export const PLANNER_EVIDENCE_TOKEN_CAP = 24_000;
const ABSOLUTE_DIRECT_TOKEN_CAP = 8_000;
const DIRECT_BUDGET_FRACTION = 0.5;
const IGNORED_WORDS = new Set([
  "about", "after", "and", "are", "document", "for", "from", "into", "make", "more", "that", "the", "this", "with", "your",
]);

export type SlimDocumentBlock =
  | { readonly kind: "paragraph"; readonly handle: string; readonly text: string; readonly styleName?: string; readonly headingLevel?: number }
  | { readonly kind: "table"; readonly handle: string; readonly tableHandle: string; readonly rowCount: number; readonly columnCount: number; readonly headerTexts: readonly string[] }
  | { readonly kind: "picture" | "page_break"; readonly handle: string };

export interface SlimDocumentStructure {
  readonly versionId: string;
  readonly blocks: readonly SlimDocumentBlock[];
}

export interface RetrievedDocumentContext {
  readonly blocks: readonly SlimDocumentBlock[];
  readonly reason: "single_table" | "first_heading" | "heading_match" | "paragraph_match" | "table_header_match";
}

export interface TableRowDetailRequest { readonly tableHandle: string; readonly rowOffset: number; readonly rowLimit: number; }

export interface WorkspaceArtifact {
  readonly documentId: string;
  readonly versionId: string;
  readonly name: string;
  readonly format: string;
}

export interface ArtifactCandidate extends WorkspaceArtifact {
  readonly reason: "primary" | "tagged" | "name_match";
}

export interface RetrievedArtifactEvidence {
  readonly artifact: WorkspaceArtifact;
  readonly context: RetrievedDocumentContext;
  readonly detail?: {
    readonly tableHandle: string;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly headerTexts: readonly string[];
    readonly rows: readonly { readonly index: number; readonly cells: readonly string[] }[];
  };
}

export interface WorkspaceRetrieval {
  readonly workingSet: readonly WorkspaceArtifact[];
  readonly documentMaps: readonly DocumentMap[];
  readonly contextStrategy: ContextStrategy;
  readonly candidates: readonly ArtifactCandidate[];
  readonly evidence: readonly RetrievedArtifactEvidence[];
  readonly plannerEvidenceBudgetTokens?: number;
  readonly fullDocumentEstimatedTokens?: number;
  readonly message?: string;
}

/** Current choice is compact maps when available; direct is reserved for tiny documents. */
export type ContextStrategy = "direct" | "hierarchical" | "retrieval";

export interface DocumentMap {
  readonly artifact: WorkspaceArtifact;
  readonly entries: readonly (
    | { readonly kind: "heading"; readonly level: number; readonly text: string }
    | { readonly kind: "table"; readonly headingPath: readonly string[]; readonly rowCount: number; readonly columnCount: number; readonly headerTexts: readonly string[] }
  )[];
}

export class SlimDocumentStructureCache {
  private readonly entries = new Map<string, Promise<SlimDocumentStructure>>();

  async get(input: {
    readonly versionId: string;
    readonly bytes: Uint8Array;
    readonly binding: DocxEngineBinding;
  }): Promise<{ readonly structure: SlimDocumentStructure; readonly cache: "hit" | "miss" }> {
    const existing = this.entries.get(input.versionId);
    if (existing) return { structure: await existing, cache: "hit" };

    const structure = loadStructure(input);
    this.entries.set(input.versionId, structure);
    if (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    try {
      return { structure: await structure, cache: "miss" };
    } catch (error) {
      this.entries.delete(input.versionId);
      throw error;
    }
  }
}

/** Cheap metadata recall before any document bytes are loaded. */
export function rankWorkspaceArtifacts(input: {
  readonly artifacts: readonly WorkspaceArtifact[];
  readonly instruction: string;
  readonly primaryDocumentId: string | null;
  readonly taggedDocumentIds: readonly string[];
}): ArtifactCandidate[] {
  const words = meaningfulWords(input.instruction);
  const tagged = new Set(input.taggedDocumentIds);
  return input.artifacts
    .map((artifact) => {
      const nameWords = meaningfulWords(stripExtension(artifact.name));
      const exactName = normalizedName(artifact.name) === normalizedName(input.instruction);
      const overlapCount = [...nameWords].filter((word) => words.has(word)).length;
      const primary = artifact.documentId === input.primaryDocumentId;
      const isTagged = tagged.has(artifact.documentId);
      const score = (exactName ? 100 : 0) + (isTagged ? 30 : 0) + (primary ? 20 : 0) + overlapCount;
      if (score === 0) return undefined;
      return {
        artifact,
        score,
        reason: exactName || overlapCount > 0 ? "name_match" as const : isTagged ? "tagged" as const : "primary" as const,
      };
    })
    .filter((value): value is { artifact: WorkspaceArtifact; score: number; reason: ArtifactCandidate["reason"] } => value !== undefined)
    .sort((a, b) => b.score - a.score || a.artifact.name.localeCompare(b.artifact.name))
    .slice(0, MAX_ARTIFACTS)
    .map(({ artifact, reason }) => ({ ...artifact, reason }));
}

/**
 * Inspect only selected DOCX candidates. The engine remains the source of all
 * document structure; metadata-only formats stay candidates without evidence.
 */
export async function retrieveWorkspaceContext(input: {
  readonly artifacts: readonly WorkspaceArtifact[];
  readonly instruction: string;
  readonly primaryDocumentId: string | null;
  readonly taggedDocumentIds: readonly string[];
  readonly workingSetDocumentIds?: readonly string[];
  readonly binding: DocxEngineBinding | undefined;
  readonly cache: SlimDocumentStructureCache;
  readonly availableEvidenceTokens?: number;
  readonly readBytes: (artifact: WorkspaceArtifact) => Promise<Uint8Array>;
}): Promise<WorkspaceRetrieval> {
  const candidates = rankWorkspaceArtifacts({
    ...input,
    taggedDocumentIds: input.workingSetDocumentIds ?? input.taggedDocumentIds,
  });
  const workingSet = workingSetArtifacts(
    input.artifacts,
    input.primaryDocumentId,
    input.workingSetDocumentIds ?? input.taggedDocumentIds,
  );
  const plannerEvidenceBudgetTokens = plannerEvidenceBudget(input.availableEvidenceTokens);
  if (!input.binding || candidates.length === 0) {
    return { workingSet, documentMaps: [], contextStrategy: "retrieval", candidates, evidence: [], ...(plannerEvidenceBudgetTokens !== undefined ? { plannerEvidenceBudgetTokens } : {}) };
  }

  const evidence: RetrievedArtifactEvidence[] = [];
  const documentMaps: DocumentMap[] = [];
  let directContent: string | undefined;
  let fullDocumentEstimatedTokens: number | undefined;
  for (const candidate of candidates) {
    if (candidate.format !== "docx") continue;
    try {
      const bytes = await input.readBytes(candidate);
      const loaded = await input.cache.get({
        versionId: candidate.versionId,
        bytes,
        binding: input.binding,
      });
      documentMaps.push(buildDocumentMap(candidate, loaded.structure));
      if (isDirectCandidate(candidate, candidates, workingSet, input.primaryDocumentId) && plannerEvidenceBudgetTokens !== undefined) {
        try {
          const complete = await formatCompleteDocument(candidate, loaded.structure, bytes, input.binding);
          const estimatedTokens = estimateTokens(complete);
          fullDocumentEstimatedTokens = estimatedTokens;
          if (estimatedTokens <= directTokenLimit(plannerEvidenceBudgetTokens)) directContent = complete;
        } catch {
          // Direct context is optional; keep the existing map/evidence path.
        }
      }
      const context = retrieveRelevantDocumentContext(input.instruction, loaded.structure);
      if (!context) continue;
      const detailRequest = selectTableRowDetail(input.instruction, context);
      const tableRows = detailRequest
        ? await input.binding.inspectDocx(bytes, { focus: { kind: "table_rows", tableHandle: detailRequest.tableHandle, rowOffset: detailRequest.rowOffset, rowLimit: detailRequest.rowLimit } })
        : undefined;
      const detail = tableRows?.ok ? tableRows.tableRows : undefined;
      evidence.push({ artifact: candidate, context, ...(detail ? { detail } : {}) });
    } catch {
      // A map is optional context. Keep the old metadata/evidence path alive.
    }
  }

  return {
    workingSet,
    documentMaps,
    contextStrategy: directContent ? "direct" : documentMaps.length > 0 ? "hierarchical" : "retrieval",
    candidates,
    evidence,
    ...(plannerEvidenceBudgetTokens !== undefined ? { plannerEvidenceBudgetTokens } : {}),
    ...(fullDocumentEstimatedTokens !== undefined ? { fullDocumentEstimatedTokens } : {}),
    ...(candidates.length > 0 ? { message: formatWorkspaceRetrievedContext(input.artifacts, candidates, evidence, input.primaryDocumentId, input.taggedDocumentIds, workingSet, directContent ? [] : documentMaps, directContent) } : {}),
  };
}

export function plannerEvidenceBudget(availableEvidenceTokens: number | undefined): number | undefined {
  return availableEvidenceTokens === undefined ? undefined : Math.min(availableEvidenceTokens, PLANNER_EVIDENCE_TOKEN_CAP);
}

function directTokenLimit(plannerEvidenceBudgetTokens: number): number {
  return Math.min(ABSOLUTE_DIRECT_TOKEN_CAP, Math.floor(plannerEvidenceBudgetTokens * DIRECT_BUDGET_FRACTION));
}

function isDirectCandidate(
  candidate: ArtifactCandidate,
  candidates: readonly ArtifactCandidate[],
  workingSet: readonly WorkspaceArtifact[],
  primaryDocumentId: string | null,
): boolean {
  return candidate.documentId === primaryDocumentId && candidate.format === "docx" && candidates.length === 1 && workingSet.length === 1;
}

async function formatCompleteDocument(
  artifact: WorkspaceArtifact,
  structure: SlimDocumentStructure,
  bytes: Uint8Array,
  binding: DocxEngineBinding,
): Promise<string> {
  const overview = await binding.inspectDocx(bytes, { focus: { kind: "overview" } });
  if (!overview.ok || !overview.overview) throw new Error("Could not inspect document overview");
  const bodyParagraphs = structure.blocks.filter((block) => block.kind === "paragraph").length;
  // body_blocks does not cover every paragraph shape (for example wrapped content).
  // A direct context must be complete, so retain the established map path instead.
  if (bodyParagraphs !== overview.overview.paragraphCount) {
    throw new Error("Body blocks do not contain every paragraph");
  }
  const tables = new Map<string, DocxInspectTableItem>();
  if (structure.blocks.some((block) => block.kind === "table")) {
    let offset = 0;
    for (;;) {
      const result = await binding.inspectDocx(bytes, { focus: { kind: "tables", offset, limit: PAGE_LIMIT } });
      if (!result.ok || !result.tables) throw new Error("Could not inspect document tables");
      for (const table of result.tables.items) tables.set(table.handle, table);
      if (!result.tables.page.hasMore) break;
      if (result.tables.page.returned === 0) throw new Error("Document table paging did not advance");
      offset += result.tables.page.returned;
    }
  }
  const lines = [`# ${stripExtension(artifact.name)}`, "Complete current-view document content:"];
  for (const block of structure.blocks) {
    if (block.kind === "paragraph") {
      lines.push(block.headingLevel !== undefined ? `${"#".repeat(Math.min(6, block.headingLevel + 1))} ${block.text}` : block.text);
    } else if (block.kind === "table") {
      const table = tables.get(block.tableHandle);
      if (!table) throw new Error("Could not match document table");
      for (const row of table.rows) lines.push(`| ${row.cells.map(markdownCell).join(" | ")} |`);
    }
  }
  return lines.join("\n\n");
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

export function buildDocumentMap(artifact: WorkspaceArtifact, structure: SlimDocumentStructure): DocumentMap {
  const entries: Array<DocumentMap["entries"][number]> = [];
  const headings: string[] = [];
  for (const block of structure.blocks) {
    if (block.kind === "paragraph" && block.headingLevel !== undefined) {
      headings.length = block.headingLevel - 1;
      headings[block.headingLevel - 1] = truncate(block.text);
      entries.push({ kind: "heading", level: block.headingLevel, text: truncate(block.text) });
    } else if (block.kind === "table") {
      entries.push({
        kind: "table",
        headingPath: headings.filter(Boolean),
        rowCount: block.rowCount,
        columnCount: block.columnCount,
        headerTexts: block.headerTexts.map(truncate),
      });
    }
  }
  return { artifact, entries };
}

export function formatDocumentMap(map: DocumentMap): string {
  const lines = [`Document: ${map.artifact.name}`];
  for (const entry of map.entries) {
    if (entry.kind === "heading") lines.push(`- ${"#".repeat(entry.level)} ${entry.text}`);
    else lines.push(`- Table${entry.headingPath.length ? ` under ${entry.headingPath.join(" > ")}` : ""}: ${entry.rowCount} rows × ${entry.columnCount} columns${entry.headerTexts.length ? `; headers: ${entry.headerTexts.join(" | ")}` : ""}`);
  }
  return lines.join("\n");
}

function workingSetArtifacts(
  artifacts: readonly WorkspaceArtifact[],
  primaryDocumentId: string | null,
  taggedDocumentIds: readonly string[],
): WorkspaceArtifact[] {
  const ids = new Set([primaryDocumentId, ...taggedDocumentIds].filter((id): id is string => id !== null));
  return artifacts.filter((artifact) => ids.has(artifact.documentId)).sort(
    (a, b) => Number(b.documentId === primaryDocumentId) - Number(a.documentId === primaryDocumentId) || a.name.localeCompare(b.name),
  );
}

async function loadStructure(input: {
  readonly versionId: string;
  readonly bytes: Uint8Array;
  readonly binding: DocxEngineBinding;
}): Promise<SlimDocumentStructure> {
  const blocks: SlimDocumentBlock[] = [];
  let offset = 0;
  for (;;) {
    const result = await input.binding.inspectDocx(input.bytes, {
      focus: { kind: "body_blocks", offset, limit: PAGE_LIMIT },
    });
    const page = result.bodyBlocks;
    if (!result.ok || !page) throw new Error("Could not inspect document structure");
    blocks.push(...page.items.flatMap(toSlimBlock));
    if (!page.page.hasMore) return { versionId: input.versionId, blocks };
    if (page.page.returned === 0) throw new Error("Document structure paging did not advance");
    offset += page.page.returned;
  }
}

function toSlimBlock(block: DocxInspectBodyBlockItem): SlimDocumentBlock[] {
  if (block.kind === "paragraph" && typeof block.text === "string") {
    return [{ kind: "paragraph", handle: block.handle, text: block.text, ...(typeof block.styleName === "string" ? { styleName: block.styleName } : {}), ...(typeof block.headingLevel === "number" ? { headingLevel: block.headingLevel } : {}) }];
  }
  if (block.kind === "table" && typeof block.tableHandle === "string" && typeof block.rowCount === "number" && typeof block.columnCount === "number" && Array.isArray(block.headerTexts)) {
    return [{ kind: "table", handle: block.handle, tableHandle: block.tableHandle, rowCount: block.rowCount, columnCount: block.columnCount, headerTexts: block.headerTexts }];
  }
  if (block.kind === "picture" || block.kind === "page_break") return [{ kind: block.kind, handle: block.handle }];
  return [];
}

export function retrieveRelevantDocumentContext(
  instruction: string,
  structure: SlimDocumentStructure,
): RetrievedDocumentContext | undefined {
  const words = meaningfulWords(instruction);
  if (words.size === 0 || /\b(?:change|replace)\b/i.test(instruction)) return undefined;

  const tables = structure.blocks.filter((block): block is Extract<SlimDocumentBlock, { kind: "table" }> => block.kind === "table");
  if (words.has("table")) {
    if (tables.length === 1) return context([tables[0]!], "single_table");
    const matched = tables.filter((table) => overlap(words, table.headerTexts.join(" ")) > 0);
    if (matched.length === 1) return context([matched[0]!], "table_header_match");
  }

  const headings = structure.blocks.filter((block): block is Extract<SlimDocumentBlock, { kind: "paragraph" }> => block.kind === "paragraph" && block.headingLevel !== undefined);
  if (words.has("heading") && words.has("first") && headings.length > 0) {
    return context(withNeighbors(structure.blocks, headings[0]!.handle), "first_heading");
  }
  const matchingHeadings = headings.filter((heading) => overlap(words, heading.text) > 0);
  if (matchingHeadings.length === 1) return context(withNeighbors(structure.blocks, matchingHeadings[0]!.handle), "heading_match");

  const paragraphs = structure.blocks.filter((block): block is Extract<SlimDocumentBlock, { kind: "paragraph" }> => block.kind === "paragraph" && block.headingLevel === undefined);
  const matchingParagraphs = paragraphs.filter((paragraph) => overlap(words, paragraph.text) >= 2);
  if (matchingParagraphs.length === 1) return context([matchingParagraphs[0]!], "paragraph_match");
  return undefined;
}

export function formatRetrievedDocumentContext(context: RetrievedDocumentContext): string {
  const lines = ["Relevant document structure:"];
  for (const block of context.blocks) {
    if (block.kind === "table") lines.push(`- Table ${block.tableHandle}: ${block.rowCount} rows × ${block.columnCount} columns; headers: ${block.headerTexts.join(" | ")}`);
    else if (block.kind === "paragraph") lines.push(`- ${block.headingLevel !== undefined ? `Heading ${block.headingLevel}` : "Paragraph"}: ${truncate(block.text)}`);
    else lines.push(`- ${block.kind === "page_break" ? "Page break" : "Picture"}`);
  }
  return lines.join("\n");
}

export function formatWorkspaceRetrievedContext(
  artifacts: readonly WorkspaceArtifact[],
  candidates: readonly ArtifactCandidate[],
  evidence: readonly RetrievedArtifactEvidence[],
  primaryDocumentId: string | null,
  taggedDocumentIds: readonly string[],
  workingSet: readonly WorkspaceArtifact[] = [],
  documentMaps: readonly DocumentMap[] = [],
  directContent?: string,
): string {
  const tagged = new Set(taggedDocumentIds);
  const catalog = [...artifacts]
    .sort((a, b) => Number(b.documentId === primaryDocumentId) - Number(a.documentId === primaryDocumentId) || a.name.localeCompare(b.name))
    .slice(0, MAX_CATALOG_ARTIFACTS);
  const lines = ["WORKSPACE / REQUEST CONTEXT", "WORKSPACE CATALOG", `${artifacts.length} documents`];
  for (const artifact of catalog) {
    const state = [artifact.documentId === primaryDocumentId ? "active" : undefined, tagged.has(artifact.documentId) ? "tagged" : undefined].filter(Boolean).join(", ");
    lines.push(`- ${artifact.name} (${artifact.format})${state ? ` [${state}]` : ""}`);
  }
  if (artifacts.length > catalog.length) lines.push(`- ${artifacts.length - catalog.length} additional documents omitted`);
  if (primaryDocumentId) lines.push("The exposed document tools are bound to the active artifact only.");
  lines.push("WORKING SET");
  for (const artifact of workingSet) lines.push(`- ${artifact.name} (${artifact.format})`);
  if (workingSet.length === 0) lines.push("- No active or tagged documents");
  if (directContent) lines.push("COMPLETE ACTIVE DOCUMENT CONTENT", directContent);
  else {
    lines.push("DOCUMENT MAPS");
    for (const map of documentMaps) lines.push(formatDocumentMap(map));
  }
  lines.push("RELEVANT ARTIFACTS");
  for (const candidate of candidates) {
    lines.push(`- ${candidate.name} (${candidate.format}; ${candidate.reason}${candidate.format === "docx" ? "" : "; semantic inspection unavailable"})`);
  }
  lines.push("RETRIEVED DOCX EVIDENCE");
  for (const item of evidence) {
    lines.push(`Document: ${item.artifact.name}`);
    lines.push(`Version: ${item.artifact.versionId}`);
    lines.push(formatRetrievedDocumentContext(item.context));
    if (item.detail) lines.push(formatTableRowDetail(item.detail));
  }
  return lines.join("\n");
}

export function selectTableRowDetail(instruction: string, context: RetrievedDocumentContext): TableRowDetailRequest | undefined {
  if (context.blocks.length !== 1 || context.blocks[0]?.kind !== "table") return undefined;
  const table = context.blocks[0];
  const words = meaningfulWords(instruction);
  const continues = /\b(?:add|continue|extend)\b/i.test(instruction);
  const headerWords = meaningfulWords(table.headerTexts.join(" "));
  const headerMatch = [...words].some((word) => headerWords.has(word) || (word.endsWith("s") && headerWords.has(word.slice(0, -1))));
  const rowMatch = words.has("row") || words.has("rows");
  if (!continues || table.columnCount > 8 || (!headerMatch && !rowMatch)) return undefined;
  const dataRows = Math.max(0, table.rowCount - 1);
  const rowLimit = Math.min(3, dataRows);
  return rowLimit > 0 ? { tableHandle: table.tableHandle, rowOffset: Math.max(1, table.rowCount - rowLimit), rowLimit } : undefined;
}

export function formatTableRowDetail(detail: { readonly tableHandle: string; readonly rowCount: number; readonly columnCount: number; readonly headerTexts: readonly string[]; readonly rows: readonly { readonly index: number; readonly cells: readonly string[] }[] }): string {
  const lines = ["Relevant recent rows:", `- Table ${detail.tableHandle}: ${detail.rowCount} rows × ${detail.columnCount} columns; headers: ${detail.headerTexts.join(" | ")}`];
  for (const row of detail.rows) lines.push(`- [${row.index}] ${row.cells.map((cell) => cell.length <= 160 ? cell : `${cell.slice(0, 159)}…`).join(" | ")}`);
  return lines.join("\n").slice(0, 2000);
}

function context(blocks: readonly SlimDocumentBlock[], reason: RetrievedDocumentContext["reason"]): RetrievedDocumentContext {
  return { blocks: blocks.slice(0, MAX_BLOCKS).map((block) => block.kind === "paragraph" ? { ...block, text: truncate(block.text) } : block), reason };
}

function withNeighbors(blocks: readonly SlimDocumentBlock[], handle: string): readonly SlimDocumentBlock[] {
  const index = blocks.findIndex((block) => block.handle === handle);
  return index < 0 ? [] : blocks.slice(Math.max(0, index - 1), index + 2);
}

function meaningfulWords(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !IGNORED_WORDS.has(word)) ?? []);
}

function overlap(words: ReadonlySet<string>, value: string): number {
  return [...meaningfulWords(value)].filter((word) => words.has(word)).length;
}

function truncate(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function stripExtension(value: string): string {
  return value.replace(/\.(docx|pptx|xlsx)$/i, "");
}

function normalizedName(value: string): string {
  return stripExtension(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
