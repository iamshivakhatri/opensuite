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
  // Use real-ish wall times so ThinkingElapsed looks sane in fixtures.
  let t = Date.now() - items.length * 1200;
  for (const item of items) {
    lines = reduceAgentProgress(lines, event(item.type, item.data ?? {}), t);
    t += 1200;
  }
  return lines;
}

const justSubmitted = reduceAll([{ type: "agent.started" }]);

const activeRun = reduceAll([
  { type: "agent.started" },
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "document.inspect" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "b", toolName: "document.inspect" },
  },
  {
    type: "tool.started",
    data: { toolCallId: "c", toolName: "document.insert_table_rows" },
  },
]);

/** Mid-run model wait after content — must show Thinking, not Finishing up. */
const betweenTools = reduceAll([
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "workspace.create_blank_document" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
  },
  { type: "message.started" },
]);

const failedTool = reduceAll([
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "document.inspect" },
  },
  {
    type: "tool.failed",
    data: {
      toolCallId: "b",
      toolName: "document.insert_table_rows",
      code: "TARGET_NOT_FOUND",
    },
  },
]);

const lifecycleDup = reduceAll([
  { type: "agent.started" },
  {
    type: "tool.completed",
    data: {
      toolCallId: "d",
      toolName: "workspace.duplicate_current_document",
    },
  },
  {
    type: "document.created",
    data: { name: "Weekly Plan copy", kind: "duplicated" },
  },
  {
    type: "tool.started",
    data: { toolCallId: "r", toolName: "document.replace_text" },
  },
]);

const completedLines = reduceAll([
  {
    type: "tool.completed",
    data: { toolCallId: "a", toolName: "document.inspect" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "b", toolName: "document.insert_table_rows" },
  },
  {
    type: "tool.completed",
    data: { toolCallId: "c", toolName: "document.replace_text" },
  },
  { type: "agent.completed" },
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
        Agent panel UX fixtures (Phase 3.5)
      </h1>
      <div className="flex flex-wrap gap-6">
        <FixtureCard title="A · Thinking" width={320}>
          <UserBubble text="Add a few more milestones to the table." />
          <AgentRunProgress
            presentation={presentAgentRun(justSubmitted, { live: true })}
            status="active"
            expanded={openJust}
            onToggle={() => setOpenJust((v) => !v)}
            live
          />
        </FixtureCard>

        <FixtureCard title="B/C · Read done + mutation active" width={320}>
          <UserBubble text="Add a few more milestones to the table." />
          <AgentRunProgress
            presentation={presentAgentRun(activeRun, { live: true })}
            status="active"
            expanded={openActive}
            onToggle={() => setOpenActive((v) => !v)}
            live
          />
        </FixtureCard>

        <FixtureCard title="D · Between tools (Thinking)" width={320}>
          <UserBubble text="Create a short poem collection document" />
          <AgentRunProgress
            presentation={presentAgentRun(betweenTools, { live: true })}
            status="active"
            expanded={false}
            onToggle={() => undefined}
            live
          />
        </FixtureCard>

        <FixtureCard title="E · Completed / collapsed" width={320}>
          <UserBubble text="Add a few more milestones to the table." />
          <AgentRunProgress
            presentation={presentAgentRun(completedLines, {
              durationMs: 12_000,
              outcome: "completed",
            })}
            status="done"
            expanded={openCompleted}
            onToggle={() => setOpenCompleted((v) => !v)}
          />
          <AgentMarkdown text="Added three milestones to the table." />
        </FixtureCard>

        <FixtureCard title="E · Expanded details" width={320}>
          <UserBubble text="Add a few more milestones to the table." />
          <AgentRunProgress
            presentation={presentAgentRun(completedLines, {
              durationMs: 12_000,
              outcome: "completed",
            })}
            status="done"
            expanded={openDetails}
            onToggle={() => setOpenDetails((v) => !v)}
          />
          <AgentMarkdown text="Added three milestones to the table." />
        </FixtureCard>

        <FixtureCard title="F · Duplicate lifecycle" width={320}>
          <UserBubble text="Create another copy and rename Key HighStone." />
          <AgentRunProgress
            presentation={presentAgentRun(lifecycleDup, { live: true })}
            status="active"
            expanded={false}
            onToggle={() => undefined}
            live
          />
        </FixtureCard>

        <FixtureCard title="G · Failed tool" width={320}>
          <UserBubble text="Add rows to the wrong table." />
          <AgentRunProgress
            presentation={presentAgentRun(failedTool, { live: true })}
            status="active"
            expanded={false}
            onToggle={() => undefined}
            live
          />
        </FixtureCard>
      </div>
    </main>
  );
}
