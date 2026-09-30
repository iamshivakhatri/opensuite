"use client";

import * as React from "react";

import { AgentRunProgress } from "@/components/documents/agent-run-progress";
import { Button } from "@/components/ui/button";
import { AgentMarkdown } from "@/lib/agent-markdown";
import {
  messageTaggedDocuments,
  presentationStepsForAssistantMessage,
} from "@/lib/agent-messages";
import {
  presentAgentRun,
  toolLabels,
  type AgentProgressLine,
  type AgentTurnProgress,
  type LiveTranscriptEntry,
} from "@/lib/agent-progress";
import type { AgentMessage, AgentStep } from "@/lib/api";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

function stepProgressLine(step: AgentStep): AgentProgressLine | null {
  if (step.kind === "narration" || step.kind === "validation" || step.status === "cancelled") return null;
  return {
    id: `step:${step.id}`,
    label: step.summary === "Completed" ? toolLabels(step.name).done : step.summary ?? step.name,
    status: step.status === "failed" ? "error" : "done",
    toolName: step.name,
  };
}

function durableTranscript(steps: readonly AgentStep[]): LiveTranscriptEntry[] {
  return steps.reduce<LiveTranscriptEntry[]>((entries, step) => {
    if (step.kind === "narration") {
      if (step.summary) entries.push({ kind: "narration", id: step.id, content: step.summary });
      return entries;
    }
    const line = stepProgressLine(step);
    if (line) entries.push({ kind: "activity", id: step.id, line });
    return entries;
  }, []);
}

function RunTranscript({
  entries,
  streaming = false,
}: {
  entries: readonly LiveTranscriptEntry[];
  streaming?: boolean;
}) {
  const parts: React.ReactNode[] = [];
  let activities: AgentProgressLine[] = [];
  const flushActivities = () => {
    if (activities.length === 0) return;
    const lines = activities;
    activities = [];
    parts.push(
      <AgentRunProgress
        key={`activities:${lines.map((line) => line.id).join(":")}`}
        presentation={presentAgentRun(lines, { live: streaming })}
        status={lines.some((line) => line.status === "active") ? "active" : "done"}
        expanded={false}
        onToggle={() => undefined}
        showDetails={false}
        live={streaming}
      />,
    );
  };
  entries.forEach((entry, index) => {
    if (entry.kind === "activity") {
      activities.push(entry.line);
      return;
    }
    flushActivities();
    const isCurrent = streaming && index === entries.length - 1;
    parts.push(
      <div key={entry.id} className={isCurrent ? "relative" : undefined}>
        <AgentMarkdown text={entry.content} streaming={isCurrent} />
        {isCurrent ? (
          <span aria-hidden className="ml-0.5 inline-block h-[0.85em] w-[2px] translate-y-[2px] animate-pulse bg-primary align-baseline" />
        ) : null}
      </div>,
    );
  });
  flushActivities();
  return <div className="flex flex-col gap-2">{parts}</div>;
}

function WorkingDots({ connectionStale, stopping }: { connectionStale: boolean; stopping: boolean }) {
  if (connectionStale || stopping) {
    return <p role="status" className="pl-1 text-[length:var(--text-2xs)] text-ink-faint">{stopping ? "Stopping…" : "Checking connection…"}</p>;
  }
  return (
    <div role="status" aria-label="Agent working" className="flex items-center gap-1.5 py-1 pl-1">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse [animation-delay:-800ms]" />
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse [animation-delay:-400ms]" />
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
    </div>
  );
}

function CompletedRunTranscript({
  steps,
  summary,
  omitFinishNarration = false,
}: {
  steps: readonly AgentStep[];
  /** Compact completion line (includes total elapsed). */
  summary?: string | null;
  /** When true, narration immediately before `finish` is omitted (answer is message.content). */
  omitFinishNarration?: boolean;
}) {
  const visibleSteps = omitFinishNarration
    ? presentationStepsForAssistantMessage(steps, true)
    : steps;
  const checks = steps.find((step) => step.kind === "validation")?.output?.checks;
  return (
    <div className="flex flex-col gap-1.5">
      {summary ? (
        <p className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-ink-faint">
          <span className="shrink-0 text-[length:var(--text-2xs)]" aria-hidden>
            ✓
          </span>
          <span className="min-w-0 truncate font-medium">{summary}</span>
        </p>
      ) : null}
      <RunTranscript entries={durableTranscript(visibleSteps)} />
      {checks?.length ? (
        <div className="mt-1 text-[length:var(--text-2xs)] text-ink-soft" aria-label="Document validation">
          <p className="font-medium">Validation</p>
          <ul className="mt-1 space-y-0.5">
            {checks.map((check) => <li key={check.id} title={check.evidence}>
              <span aria-hidden>{check.status === "pass" ? "✓" : check.status === "warning" ? "⚠" : check.status === "fail" ? "!" : "–"}</span> {check.message}
              {check.evidence ? <span className="block truncate pl-3 text-ink-faint">{check.evidence}</span> : null}
            </li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export type AgentTranscriptProps = {
  showEmpty: boolean;
  pagination: {
    hasMore: boolean;
    loading: boolean;
    error: string | null;
    onLoadOlder: () => void;
  };
  messages: readonly AgentMessage[];
  runStepsByMessageId: Readonly<Record<string, readonly AgentStep[]>>;
  documentsForTags: readonly { readonly id: string; readonly name: string }[];
  live: {
    active: boolean;
    entries: readonly LiveTranscriptEntry[];
    connectionStale: boolean;
    stopping: boolean;
  };
  turn: {
    last: AgentTurnProgress | null;
    terminalSteps: readonly AgentStep[] | null;
    showProgressOnLastAssistant: boolean;
    showFinishedProgress: boolean;
    timelineOpen: boolean;
    onToggleTimeline: () => void;
  };
  actions: {
    continueRunId: string | null;
    canRetry: boolean;
    busy: boolean;
    submitting: boolean;
    onContinue: () => void;
    onRetry: () => void;
    onOpenAiSettings: () => void;
  };
  notices: {
    versionNumber: number | null;
    run: string | null;
    error: string | null;
    needsAiSettings: boolean;
    /** When error text equals this message's content, hide duplicate markdown. */
    hideErrorContentMessageId: string | null;
  };
};

/** Durable + live conversation display for the agent panel (presentation only). */
export function AgentTranscript({
  showEmpty,
  pagination,
  messages,
  runStepsByMessageId,
  documentsForTags,
  live,
  turn,
  actions,
  notices,
}: AgentTranscriptProps) {
  return (
    <>
      {showEmpty ? (
        <div className="flex h-full min-h-[120px] items-center justify-center px-2 text-center">
          <p className="max-w-[240px] text-[length:var(--text-panel)] leading-relaxed text-ink-faint">
            Ask OpenSuite to create or edit documents. Use @ to tag files,
            or drag them from the explorer.
          </p>
        </div>
      ) : null}

      {pagination.hasMore ? (
        <div className="mb-3 flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={pagination.onLoadOlder}
            disabled={pagination.loading}
            aria-label="Load earlier messages"
            className={cn(
              focusRingClass,
              "rounded-[var(--radius-sm)] px-2.5 py-1 text-[length:var(--text-xs)] font-medium text-link hover:text-link-hover hover:underline disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {pagination.loading
              ? "Loading earlier messages…"
              : "Load earlier messages"}
          </button>
          {pagination.error ? (
            <p className="text-[length:var(--text-xs)] text-danger">
              {pagination.error}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          const transcriptSteps = runStepsByMessageId[message.id];
          if (message.role === "user") {
            const messageTags = messageTaggedDocuments(message, documentsForTags);
            const isContinue = message.content.trim() === "Continue";
            return (
              <div
                key={message.id}
                className={cn(
                  "text-ink",
                  isContinue
                    ? "self-start rounded-[var(--radius-sm)] border border-stroke px-2 py-0.5 text-[length:var(--text-xs)] font-medium"
                    : "rounded-[var(--radius-md)] bg-secondary-soft px-2.5 py-2 text-[length:var(--text-panel)] leading-[1.55]",
                )}
              >
                {!isContinue && messageTags.length > 0 ? (
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {messageTags.map((file) => (
                      <span
                        key={file.id}
                        className="inline-flex max-w-full rounded-[var(--radius-sm)] bg-primary-soft px-1.5 py-0.5 text-[length:var(--text-2xs)] font-medium text-primary-hover"
                      >
                        @{file.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {message.content}
              </div>
            );
          }
          return (
            <div key={message.id} className="flex flex-col gap-1.5">
              {transcriptSteps ? (
                <CompletedRunTranscript
                  steps={transcriptSteps}
                  omitFinishNarration={message.content.length > 0}
                  summary={
                    isLast && turn.last && turn.last.outcome !== "paused"
                      ? presentAgentRun(turn.last.lines, {
                          durationMs: turn.last.durationMs,
                          outcome: turn.last.outcome,
                        }).headline
                      : null
                  }
                />
              ) : isLast && turn.showProgressOnLastAssistant && turn.last ? (
                <AgentRunProgress
                  presentation={presentAgentRun(turn.last.lines, {
                    durationMs: turn.last.durationMs,
                    outcome: turn.last.outcome,
                  })}
                  status={
                    turn.last.outcome === "failed" ? "error" : "done"
                  }
                  expanded={turn.timelineOpen}
                  onToggle={turn.onToggleTimeline}
                  showCompletedSummary
                />
              ) : null}
              {!(isLast && notices.hideErrorContentMessageId === message.id && notices.error === message.content) ? (
                <AgentMarkdown text={message.content} />
              ) : null}
              {isLast && actions.continueRunId ? (
                <button
                  type="button"
                  onClick={actions.onContinue}
                  disabled={actions.busy}
                  className={cn(focusRingClass, "self-start rounded-[var(--radius-sm)] border border-stroke px-2 py-0.5 text-[length:var(--text-xs)] font-medium text-ink-soft hover:border-primary disabled:opacity-50")}
                >
                  {actions.submitting ? "Starting…" : "Continue"}
                </button>
              ) : null}
            </div>
          );
        })}

        {/* Live narration and tool rows keep their observed order. */}
        {live.active ? (
          <div className="flex flex-col gap-2">
            {live.entries.length > 0 ? <RunTranscript entries={live.entries} streaming /> : null}
            <WorkingDots connectionStale={live.connectionStale} stopping={live.stopping} />
          </div>
        ) : null}

        {/* Finished turn with no assistant text yet (cancel / fail). */}
        {!live.active && turn.terminalSteps ? (
          <CompletedRunTranscript
            steps={turn.terminalSteps}
            summary={
              turn.last
                ? presentAgentRun(turn.last.lines, {
                    durationMs: turn.last.durationMs,
                    outcome: turn.last.outcome,
                  }).headline
                : null
            }
          />
        ) : null}
        {!live.active &&
        turn.last &&
        turn.showFinishedProgress &&
        !turn.showProgressOnLastAssistant ? (
          <AgentRunProgress
            presentation={presentAgentRun(turn.last.lines, {
              durationMs: turn.last.durationMs,
              outcome: turn.last.outcome,
            })}
            status={turn.last.outcome === "failed" ? "error" : "done"}
            expanded={turn.timelineOpen}
            onToggle={turn.onToggleTimeline}
            showCompletedSummary
          />
        ) : null}

        {notices.versionNumber !== null ? (
          <p className="flex items-center gap-1.5 text-[length:var(--text-2xs)] text-ink-faint">
            <span
              aria-hidden
              className="h-1 w-1 shrink-0 rounded-full bg-ink-faint/70"
            />
            Document updated to{" "}
            <span className="font-medium tabular-nums text-ink-soft">
              v{notices.versionNumber}
            </span>
          </p>
        ) : null}

        {notices.run ? (
          <p className="text-[length:var(--text-2xs)] text-ink-faint">
            {notices.run}
          </p>
        ) : null}

        {notices.error ? (
          <div className="flex items-start gap-2 border-l-2 border-danger bg-danger-soft/50 px-2.5 py-2 text-[length:var(--text-panel)] text-danger">
            <p className="min-w-0 flex-1 leading-snug">{notices.error}</p>
            {notices.needsAiSettings ? (
              <Button type="button" variant="outline" size="sm" onClick={actions.onOpenAiSettings}
                className="h-6 shrink-0 border-danger/30 px-2 text-[length:var(--text-xs)] text-danger hover:bg-danger-soft">
                AI settings
              </Button>
            ) : actions.canRetry ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={actions.onRetry}
                disabled={actions.busy}
                className="h-6 shrink-0 border-danger/30 px-2 text-[length:var(--text-xs)] text-danger hover:bg-danger-soft"
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        {!notices.error && actions.canRetry ? (
          <button
            type="button"
            onClick={actions.onRetry}
            disabled={actions.busy}
            className={cn(
              focusRingClass,
              "self-start rounded-[var(--radius-sm)] text-[length:var(--text-xs)] font-medium text-link hover:text-link-hover hover:underline disabled:opacity-50",
            )}
          >
            Retry last request
          </button>
        ) : null}
      </div>
    </>
  );
}
