"use client";

import * as React from "react";

import { AgentRunProgress } from "@/components/documents/agent-run-progress";
import { AgentMarkdown } from "@/lib/agent-markdown";
import {
  presentAgentRun,
  reduceAgentProgress,
  type AgentProgressLine,
} from "@/lib/agent-progress";
import type { AgentLiveEvent } from "@/lib/api";
import { cn } from "@/lib/utils";

function event(
  type: string,
  data: Record<string, unknown> = {},
): AgentLiveEvent {
  return { id: 1, runId: "preview", type, at: new Date().toISOString(), data };
}

function reduceAll(
  items: Array<{ type: string; data?: Record<string, unknown> }>,
): AgentProgressLine[] {
  let lines: AgentProgressLine[] = [];
  let t = 1;
  for (const item of items) {
    lines = reduceAgentProgress(lines, event(item.type, item.data ?? {}), t);
    t += 1;
  }
  return lines;
}

const justSubmitted = reduceAll([{ type: "agent.started" }]);

const activeRun = reduceAll([
  { type: "agent.started" },
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "workspace.create_blank_docx" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "c", toolName: "document.set_paragraph_style" },
  },
  {
    type: "tool.started",
    data: { toolCallId: "d", toolName: "document.set_paragraph_formatting" },
  },
]);

const completedLines = reduceAll([
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "workspace.create_blank_docx" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "c", toolName: "document.set_paragraph_style" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "d", toolName: "document.set_paragraph_formatting" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "e", toolName: "document.set_paragraph_formatting" },
  },
  {
    type: "tool.failed",
    data: {
      toolCallId: "f",
      toolName: "document.set_paragraph_style",
      code: "TARGET_AMBIGUOUS",
    },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "g", toolName: "document.set_paragraph_style" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "h", toolName: "document.set_text_formatting" },
  },
  { type: "agent.completed" },
]);

const narrowLines = reduceAll([
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "document.inspect" },
  },
  {
    type: "tool.started",
    data: { toolCallId: "b", toolName: "document.set_page_number" },
  },
]);

function FixtureCard({
  title,
  width,
  children,
  className,
}: {
  title: string;
  width: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-[var(--radius-md)] border border-line bg-sidebar p-3",
        className,
      )}
      style={{ width }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
        {title}
      </p>
      {children}
    </section>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-sunken px-2.5 py-2 text-[length:var(--text-sm)] leading-[1.55] text-ink">
      {text}
    </div>
  );
}

/**
 * Temporary visual board for Agent panel UX. Not linked from product nav.
 * Remove after milestone validation if undesired in the tree.
 */
export default function AgentPanelUxPreviewPage() {
  const [openCompleted, setOpenCompleted] = React.useState(false);
  const [openDetails, setOpenDetails] = React.useState(true);
  const [openActive, setOpenActive] = React.useState(false);
  const [openNarrow, setOpenNarrow] = React.useState(false);
  const [openJust, setOpenJust] = React.useState(false);

  if (process.env.NODE_ENV === "production") {
    return (
      <main className="grid min-h-screen place-items-center bg-paper text-ink-faint">
        Not available
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-paper p-6 text-ink">
      <h1 className="mb-4 text-[length:var(--text-lg)] font-semibold tracking-[-0.02em]">
        Agent panel UX fixtures
      </h1>
      <div className="flex flex-wrap gap-6">
        <FixtureCard title="1 · Just after submit" width={320}>
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(justSubmitted, { live: true })}
            status="active"
            totalElapsed="0.4s"
            expanded={openJust}
            onToggle={() => setOpenJust((v) => !v)}
            live
          />
        </FixtureCard>

        <FixtureCard title="2 · Active run" width={320}>
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(activeRun, { live: true })}
            status="active"
            totalElapsed="18s"
            expanded={openActive}
            onToggle={() => setOpenActive((v) => !v)}
            live
          />
        </FixtureCard>

        <FixtureCard title="3 · Completed" width={320}>
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(completedLines, {
              durationMs: 68_000,
              outcome: "completed",
            })}
            status="done"
            expanded={openCompleted}
            onToggle={() => setOpenCompleted((v) => !v)}
          />
          <AgentMarkdown text="Created **Poems of Inspiration.docx** with a title page and three short poems, lightly formatted for reading." />
        </FixtureCard>

        <FixtureCard title="4 · Expanded details" width={320}>
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(completedLines, {
              durationMs: 68_000,
              outcome: "completed",
            })}
            status="done"
            expanded={openDetails}
            onToggle={() => setOpenDetails((v) => !v)}
          />
          <AgentMarkdown text="Created **Poems of Inspiration.docx**." />
        </FixtureCard>

        <FixtureCard title="5 · Narrow panel" width={260}>
          <UserBubble text="Add page numbers and tighten spacing" />
          <AgentRunProgress
            presentation={presentAgentRun(narrowLines, { live: true })}
            status="active"
            totalElapsed="6.2s"
            expanded={openNarrow}
            onToggle={() => setOpenNarrow((v) => !v)}
            live
          />
        </FixtureCard>

        <FixtureCard title="6 · Dark completed" width={320} className="bg-sidebar">
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(completedLines, {
              durationMs: 68_000,
              outcome: "completed",
            })}
            status="done"
            expanded={false}
            onToggle={() => undefined}
          />
          <AgentMarkdown text="Created **Poems of Inspiration.docx**." />
        </FixtureCard>
      </div>
    </main>
  );
}
