import * as React from "react";

import { parseBlocks, type MdBlock } from "./agent-markdown-parse";
import { cn } from "@/lib/utils";

/**
 * Lightweight markdown for agent replies — bold, italics, headings, hr, lists,
 * GFM tables, paragraphs. No HTML passthrough.
 */
export function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  /** Slightly softer body while tokens are still arriving. */
  streaming?: boolean;
}) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);

  return (
    <div
      className={cn(
        "agent-md text-[length:var(--text-panel)] leading-[1.55]",
        streaming ? "text-ink-soft" : "text-ink",
      )}
    >
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

export { parseBlocks } from "./agent-markdown-parse";

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "hr":
      return <hr className="my-2 border-0 border-t border-line" />;
    case "h": {
      const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      const size =
        block.level === 1
          ? "text-[length:var(--text-sm)]"
          : block.level === 2
            ? "text-[length:var(--text-panel)]"
            : "text-[length:var(--text-panel)]";
      return (
        <Tag
          className={cn(
            "mb-1 mt-2.5 font-semibold tracking-[-0.01em] text-ink first:mt-0",
            size,
          )}
        >
          <Inline text={block.text} />
        </Tag>
      );
    }
    case "ul":
      return (
        <ul className="mb-2 list-disc space-y-0.5 pl-4 text-ink-soft marker:text-ink-faint">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mb-2 list-decimal space-y-0.5 pl-4 text-ink-soft marker:text-ink-faint">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="mb-2 overflow-x-auto rounded-[var(--radius-sm)] border border-line">
          <table className="w-full border-collapse text-left text-[length:var(--text-xs)]">
            <thead>
              <tr className="border-b border-line bg-sunken">
                {block.headers.map((header, i) => (
                  <th
                    key={i}
                    className="px-2 py-1.5 font-semibold text-ink"
                  >
                    <Inline text={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-line last:border-b-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2 py-1.5 text-ink-soft">
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "p":
      return (
        <p className="mb-1.5 whitespace-pre-wrap last:mb-0">
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
            className="rounded-[var(--radius-sm)] bg-sunken px-1 py-px font-mono text-[length:var(--text-xs)] text-ink"
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
