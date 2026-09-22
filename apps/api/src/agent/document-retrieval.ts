import type {
  DocxEngineBinding,
  DocxInspectBodyBlockItem,
} from "@opensuite/engine-client";

const CACHE_LIMIT = 64;
const PAGE_LIMIT = 100;
const MAX_BLOCKS = 5;
const MAX_TEXT_LENGTH = 240;
const MAX_ARTIFACTS = 3;
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
  readonly candidates: readonly ArtifactCandidate[];
  readonly evidence: readonly RetrievedArtifactEvidence[];
  readonly message?: string;
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
  readonly binding: DocxEngineBinding | undefined;
  readonly cache: SlimDocumentStructureCache;
  readonly readBytes: (artifact: WorkspaceArtifact) => Promise<Uint8Array>;
}): Promise<WorkspaceRetrieval> {
  const candidates = rankWorkspaceArtifacts(input);
  if (!input.binding || candidates.length === 0) return { candidates, evidence: [] };

  const evidence: RetrievedArtifactEvidence[] = [];
  for (const candidate of candidates) {
    if (candidate.format !== "docx") continue;
    const bytes = await input.readBytes(candidate);
    const loaded = await input.cache.get({
      versionId: candidate.versionId,
      bytes,
      binding: input.binding,
    });
    const context = retrieveRelevantDocumentContext(input.instruction, loaded.structure);
    if (!context) continue;
    const detailRequest = selectTableRowDetail(input.instruction, context);
    const tableRows = detailRequest
      ? await input.binding.inspectDocx(bytes, { focus: { kind: "table_rows", tableHandle: detailRequest.tableHandle, rowOffset: detailRequest.rowOffset, rowLimit: detailRequest.rowLimit } })
      : undefined;
    const detail = tableRows?.ok ? tableRows.tableRows : undefined;
    evidence.push({
      artifact: candidate,
      context,
      ...(detail ? { detail } : {}),
    });
  }

  return {
    candidates,
    evidence,
    ...(candidates.length > 0 ? { message: formatWorkspaceRetrievedContext(candidates, evidence) } : {}),
  };
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
  candidates: readonly ArtifactCandidate[],
  evidence: readonly RetrievedArtifactEvidence[],
): string {
  const lines = ["WORKSPACE / REQUEST CONTEXT", "LIKELY ARTIFACTS"];
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
