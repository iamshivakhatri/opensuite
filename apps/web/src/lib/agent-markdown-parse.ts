/**
 * Block parser for agent chat markdown (no React). Used by AgentMarkdown.
 */

export type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "hr" }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | {
      kind: "table";
      headers: string[];
      rows: string[][];
    };

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = splitTableCells(trimmed);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

export function parseBlocks(text: string): MdBlock[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: "h",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }

    if (
      isTableRow(trimmed) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? "")
    ) {
      const headers = splitTableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        const cells = splitTableCells(lines[i] ?? "");
        const normalizedRow = headers.map((_, idx) => cells[idx] ?? "");
        rows.push(normalizedRow);
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? "").trim();
        const m = /^[-*]\s+(.+)$/.exec(item);
        if (!m) break;
        items.push(m[1]!);
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? "").trim();
        const m = /^\d+\.\s+(.+)$/.exec(item);
        if (!m) break;
        items.push(m[1]!);
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      const t = current.trim();
      if (t === "") break;
      if (/^---+$/.test(t) || /^\*\*\*+$/.test(t)) break;
      if (/^#{1,3}\s+/.test(t)) break;
      if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) break;
      if (
        isTableRow(t) &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1] ?? "")
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }

  return blocks;
}
