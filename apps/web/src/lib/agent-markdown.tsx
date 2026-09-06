import * as React from "react";

/**
 * Lightweight markdown for agent replies — bold, italics, headings, hr, lists,
 * paragraphs. No HTML passthrough.
 */
export function AgentMarkdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="agent-md text-[11px] leading-[1.65] text-ink-soft">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "hr" }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "hr":
      return <hr className="my-2.5 border-0 border-t border-line" />;
    case "h": {
      const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      const size =
        block.level === 1
          ? "text-[12.5px]"
          : block.level === 2
            ? "text-[12px]"
            : "text-[11.5px]";
      return (
        <Tag className={`mb-1.5 mt-2 font-semibold text-ink first:mt-0 ${size}`}>
          <Inline text={block.text} />
        </Tag>
      );
    }
    case "ul":
      return (
        <ul className="mb-2 list-disc space-y-0.5 pl-4">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mb-2 list-decimal space-y-0.5 pl-4">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      );
    case "p":
      return (
        <p className="mb-2 whitespace-pre-wrap last:mb-0">
          <Inline text={block.text} />
        </p>
      );
    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
}

function Inline({ text }: { text: string }) {
  const parts = React.useMemo(() => parseInline(text), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "bold" ? (
          <strong key={i} className="font-semibold text-ink">
            {part.text}
          </strong>
        ) : part.kind === "em" ? (
          <em key={i}>{part.text}</em>
        ) : part.kind === "code" ? (
          <code
            key={i}
            className="rounded-[4px] bg-sunken px-1 py-0.5 font-mono text-[10px] text-ink"
          >
            {part.text}
          </code>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}

type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

function parseInline(input: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index > last) {
      parts.push({ kind: "text", text: input.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      parts.push({ kind: "bold", text: match[2] });
    } else if (match[3] !== undefined) {
      parts.push({ kind: "em", text: match[3] });
    } else if (match[4] !== undefined) {
      parts.push({ kind: "code", text: match[4] });
    }
    last = match.index + match[0].length;
  }
  if (last < input.length) {
    parts.push({ kind: "text", text: input.slice(last) });
  }
  return parts.length > 0 ? parts : [{ kind: "text", text: input }];
}

function parseBlocks(text: string): MdBlock[] {
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

    // Paragraph: gather consecutive non-empty, non-structural lines.
    // Single newlines inside a stanza become soft breaks (whitespace-pre-wrap).
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      const t = current.trim();
      if (t === "") break;
      if (/^---+$/.test(t) || /^\*\*\*+$/.test(t)) break;
      if (/^#{1,3}\s+/.test(t)) break;
      if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) break;
      para.push(current);
      i += 1;
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }

  return blocks;
}
