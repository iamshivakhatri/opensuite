"use client";

import * as React from "react";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import { Button } from "@/components/ui/button";
import type { PromptAttachment } from "@/lib/agent-prompt-attachments";
import { formatProgressElapsed } from "@/lib/agent-progress";
import type { ListedDocument } from "@/lib/api";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

type ComposerTag = {
  readonly id: string;
  readonly name: string;
  readonly format: string;
};

type AgentComposerProps = {
  byokModelLabel: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  tags: {
    items: readonly ComposerTag[];
    workspaceFiles: readonly ListedDocument[];
    onAdd: (file: ComposerTag) => void;
    onRemove: (id: string) => void;
  };
  attachments: {
    items: readonly PromptAttachment[];
    error: string | null;
    onAttach: (files: File[]) => void;
    onRemove: (file: File) => void;
  };
  status: {
    ready: boolean;
    busy: boolean;
    canStop: boolean;
    cancelling: boolean;
    submitting: boolean;
    dragOver: boolean;
    wallClockMs: number | null;
  };
  onSubmit: () => void;
  onStop: () => void;
};

/** Composer presentation + local mention/keyboard interaction for the agent panel. */
export function AgentComposer({
  byokModelLabel,
  draft,
  onDraftChange,
  tags,
  attachments,
  status,
  onSubmit,
  onStop,
}: AgentComposerProps) {
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = React.useRef<HTMLInputElement>(null);
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");

  React.useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, 40), 160);
    el.style.height = `${next}px`;
  }, [draft]);

  // Close mention picker when the panel clears the draft or starts a run.
  React.useEffect(() => {
    if (draft.length === 0 || status.submitting || status.canStop) {
      setMentionOpen(false);
      setMentionQuery("");
    }
  }, [draft, status.submitting, status.canStop]);

  function updateDraftAndMention(value: string) {
    onDraftChange(value);
    const cursor = composerRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (match) {
      setMentionOpen(true);
      setMentionQuery(match[1] ?? "");
    } else {
      setMentionOpen(false);
      setMentionQuery("");
    }
  }

  function applyMention(file: ListedDocument) {
    const el = composerRef.current;
    const value = draft;
    const cursor = el?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const replaced = before.replace(/(?:^|\s)@([^\s@]*)$/, (full) => {
      const leading = full.startsWith("@") ? "" : full[0] ?? "";
      return `${leading}`;
    });
    onDraftChange(replaced + after);
    tags.onAdd({ id: file.id, name: file.name, format: file.format });
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => {
      el?.focus();
    });
  }

  const mentionMatches = React.useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.trim().toLowerCase();
    const taggedIds = new Set(tags.items.map((file) => file.id));
    return tags.workspaceFiles
      .filter((file) => !taggedIds.has(file.id))
      .filter((file) => (q ? file.name.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [mentionOpen, mentionQuery, tags.items, tags.workspaceFiles]);

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen && mentionMatches.length > 0 && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      applyMention(mentionMatches[0]!);
      return;
    }
    if (event.key === "Escape" && mentionOpen) {
      event.preventDefault();
      setMentionOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-sidebar px-3 py-2.5">
      {byokModelLabel ? (
        <p
          className="mb-1.5 truncate px-0.5 text-[length:var(--text-2xs)] text-ink-faint"
          title={byokModelLabel}
        >
          {byokModelLabel}
        </p>
      ) : null}
      <div
        className={cn(
          "os-composer rounded-[var(--radius-md)] border bg-surface p-2",
          status.dragOver
            ? "border-primary border-dashed"
            : "border-line",
          status.canStop && "opacity-95",
        )}
      >
        {tags.items.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {tags.items.map((file) => (
              <button
                key={file.id}
                type="button"
                title="Remove tag"
                aria-label={`Remove tag ${file.name}`}
                onClick={() => tags.onRemove(file.id)}
                className={cn(
                  focusRingClass,
                  "inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] bg-primary-soft px-1.5 py-0.5 text-[length:var(--text-2xs)] font-medium text-primary-hover",
                )}
              >
                <span className="truncate">@{file.name}</span>
                <span className="opacity-60">×</span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.items.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {attachments.items.map(({ file, document }) => (
              <button
                key={file.name + file.lastModified + file.size}
                type="button"
                title={`Remove ${file.name}`}
                aria-label={`Remove attachment ${file.name}`}
                disabled={status.busy}
                onClick={() => attachments.onRemove(file)}
                className={cn(focusRingClass, "inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] bg-primary-soft px-1.5 py-0.5 text-[length:var(--text-2xs)] font-medium text-primary-hover disabled:opacity-50")}
              >
                <span className="truncate">{file.name}</span>
                <span className="opacity-60">{document ? "Uploaded" : status.submitting ? "Uploading" : "Ready"} · ×</span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.error ? <p role="alert" className="mb-1.5 text-[length:var(--text-xs)] text-danger">{attachments.error}</p> : null}
        <div className="relative">
          {mentionOpen && mentionMatches.length > 0 ? (
            <div className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-1 max-h-[180px] overflow-y-auto rounded-[var(--radius-md)] border border-line bg-surface py-1 shadow-[var(--elevation-sm)]">
              {mentionMatches.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => applyMention(file)}
                  className={cn(
                    focusRingClass,
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[length:var(--text-sm)] text-ink hover:bg-primary-soft",
                  )}
                >
                  <DocumentFormatIcon
                    format={file.format}
                    size="sm"
                    className="text-ink-faint"
                  />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            disabled={status.canStop || !status.ready}
            onChange={(event) => updateDraftAndMention(event.target.value)}
            onKeyDown={onComposerKeyDown}
            aria-label="Message to agent"
            placeholder={
              status.canStop ? undefined : "Ask OpenSuite… (@ to tag a file)"
            }
            className={cn(
              focusRingClass,
              "max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-none bg-transparent text-[length:var(--text-panel)] leading-[1.5] text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint",
            )}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <input
              ref={attachmentInputRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              className="sr-only"
              aria-label="Attach DOCX files"
              onChange={(event) => {
                attachments.onAttach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button type="button" disabled={status.busy || !status.ready} onClick={() => attachmentInputRef.current?.click()} aria-label="Attach DOCX files" title="Attach DOCX files" className={cn(focusRingClass, "rounded-[var(--radius-sm)] px-1 text-[length:var(--text-sm)] text-ink-faint hover:text-ink disabled:opacity-50")}>＋</button>
            <span className="truncate text-[length:var(--text-2xs)] tabular-nums text-ink-faint">
              {status.canStop && status.wallClockMs !== null ? formatProgressElapsed(status.wallClockMs) : null}
            </span>
          </div>
          {status.canStop ? (
            <Button
              type="button"
              variant="primary"
              size="icon"
              onClick={onStop}
              disabled={status.cancelling}
              title="Stop"
              aria-label="Stop agent run"
              className="shrink-0"
            >
              {status.cancelling ? (
                <span className="text-[length:var(--text-2xs)]">…</span>
              ) : (
                <span className="block h-[10px] w-[10px] rounded-[1.5px] bg-on-ink" />
              )}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="icon"
              disabled={
                status.busy || !status.ready || draft.trim().length === 0
              }
              onClick={onSubmit}
              title="Send"
              aria-label="Send message"
              className="shrink-0 disabled:bg-primary-soft disabled:text-ink-faint disabled:opacity-100"
            >
              ➤
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
