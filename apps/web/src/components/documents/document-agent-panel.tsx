"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import { userFacingError } from "@/components/files/format";
import {
  agentRunDurationMs,
  formatProgressElapsed,
  latestProgressHeadline,
  presentAgentRun,
  reduceAgentProgress,
  visibleAgentProgress,
  type AgentProgressLine,
  type AgentTurnProgress,
} from "@/lib/agent-progress";
import { AgentRunProgress } from "@/components/documents/agent-run-progress";
import { AgentMarkdown } from "@/lib/agent-markdown";
import { shouldAcceptSubmit } from "@/lib/agent-submit";
import {
  ApiError,
  cancelAgentRun,
  createWorkspaceAgentThread,
  getAgentMessages,
  getAgentRun,
  getDocument,
  isActiveAgentRunStatus,
  listDocuments,
  listWorkspaceAgentThreads,
  resolveAgentConfirmation,
  startAgentRun,
  subscribeAgentRunEvents,
  type AgentMessage,
  type AgentRun,
  type AgentRunStatus,
  type AgentThread,
  type ListedDocument,
} from "@/lib/api";
import {
  OPENSUITE_DOCUMENT_DRAG_MIME,
  parseDocumentDragPayload,
} from "@/lib/document-drag";
import { Button } from "@/components/ui/button";
import { documentPath } from "@/lib/paths";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

type PanelPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type TaggedDocument = {
  readonly id: string;
  readonly name: string;
  readonly format: string;
};

function threadLabel(thread: AgentThread): string {
  if (thread.title?.trim()) return thread.title.trim();
  const d = new Date(thread.updatedAt);
  return `Chat · ${d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * Workspace-scoped OpenSuite agent panel (Cursor-style).
 * Tag files with @ or drag from the explorer; optional active file is used
 * as primary when nothing is tagged.
 */
export function DocumentAgentPanel({
  workspaceId,
  documentId,
  documentName,
  collapsed,
  onToggle,
  width = 320,
  onDocumentUpdated,
  onDocumentCreated,
}: {
  workspaceId: string;
  documentId: string | null;
  documentName?: string;
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  /** Fired when an agent run persists a newer document version. */
  onDocumentUpdated?: (document: ListedDocument) => void;
  /** Fired when the agent creates a new workspace document (blank DOCX). */
  onDocumentCreated?: (document: ListedDocument) => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<PanelPhase>({ kind: "loading" });
  const [threads, setThreads] = React.useState<AgentThread[]>([]);
  const [threadId, setThreadId] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const historyAnchorRef = React.useRef<HTMLButtonElement>(null);
  const historyMenuRef = React.useRef<HTMLDivElement>(null);
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [tagged, setTagged] = React.useState<TaggedDocument[]>([]);
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const [workspaceFiles, setWorkspaceFiles] = React.useState<ListedDocument[]>(
    [],
  );
  const [dragOverComposer, setDragOverComposer] = React.useState(false);
  const [activeRun, setActiveRun] = React.useState<AgentRun | null>(null);
  const [progress, setProgress] = React.useState<AgentProgressLine[]>([]);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runNotice, setRunNotice] = React.useState<string | null>(null);
  /** Whether a retry affordance should be shown for the last user message. */
  const [canRetryRun, setCanRetryRun] = React.useState(false);
  /** Latest "document updated to vN" acknowledgement for the active document. */
  const [versionNotice, setVersionNotice] = React.useState<{
    documentId: string;
    versionNumber: number;
  } | null>(null);
  /** Detail for the currently pending confirmation.required tool, if any. */
  const [pendingConfirmation, setPendingConfirmation] = React.useState<{
    toolCallId: string;
    toolName: string;
    reason: string;
  } | null>(null);
  /** True while an Approve/Deny request is in flight. */
  const [confirmingDecision, setConfirmingDecision] = React.useState(false);
  const [confirmationError, setConfirmationError] = React.useState<
    string | null
  >(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [creatingChat, setCreatingChat] = React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const sseAbortRef = React.useRef<(() => void) | null>(null);
  const runIdRef = React.useRef<string | null>(null);
  const submitLockRef = React.useRef(false);
  /** Bumps on every subscribe so stale onDisconnect/onError cannot finalize the wrong run. */
  const sseGenerationRef = React.useRef(0);
  const reconnectAttemptsRef = React.useRef(0);
  const versionRefreshTimerRef = React.useRef<number | null>(null);
  const pendingVersionDocIdRef = React.useRef<string | null>(null);
  const runStartedAtRef = React.useRef<number | null>(null);
  const stickToBottomRef = React.useRef(true);
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const [runTotalMs, setRunTotalMs] = React.useState<number | null>(null);
  /** Last finished turn (timeline + total) — replaced each new run. */
  const [lastTurn, setLastTurn] = React.useState<AgentTurnProgress | null>(null);
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const progressRef = React.useRef<AgentProgressLine[]>([]);
  const [liveDraft, setLiveDraft] = React.useState<{
    messageId: string;
    content: string;
  } | null>(null);

  const busy =
    submitting ||
    cancelling ||
    creatingChat ||
    (activeRun !== null && isActiveAgentRunStatus(activeRun.status));

  const stopSse = React.useCallback(() => {
    sseGenerationRef.current += 1;
    sseAbortRef.current?.();
    sseAbortRef.current = null;
  }, []);

  const flushDocumentVersionRefresh = React.useCallback(() => {
    if (versionRefreshTimerRef.current !== null) {
      window.clearTimeout(versionRefreshTimerRef.current);
      versionRefreshTimerRef.current = null;
    }
    const id = pendingVersionDocIdRef.current;
    pendingVersionDocIdRef.current = null;
    if (!id) return;
    void getDocument(id)
      .then((fresh) => {
        onDocumentUpdated?.(fresh);
        if (documentId && fresh.id === documentId) {
          setVersionNotice({
            documentId: fresh.id,
            versionNumber: fresh.latestVersion.versionNumber,
          });
        }
      })
      .catch(() => {
        // Editor can still pick up the version on focus refresh.
      });
  }, [documentId, onDocumentUpdated]);

  const scheduleDocumentVersionRefresh = React.useCallback(
    (advancedDocumentId: string) => {
      pendingVersionDocIdRef.current = advancedDocumentId;
      if (versionRefreshTimerRef.current !== null) {
        window.clearTimeout(versionRefreshTimerRef.current);
      }
      // Coalesce multi-mutation advances into one editor reload.
      versionRefreshTimerRef.current = window.setTimeout(() => {
        versionRefreshTimerRef.current = null;
        flushDocumentVersionRefresh();
      }, 800);
    },
    [flushDocumentVersionRefresh],
  );

  React.useEffect(() => {
    return () => {
      if (versionRefreshTimerRef.current !== null) {
        window.clearTimeout(versionRefreshTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!historyOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setHistoryOpen(false);
        historyAnchorRef.current?.focus({ preventScroll: true });
      }
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (historyMenuRef.current?.contains(target)) return;
      if (historyAnchorRef.current?.contains(target)) return;
      setHistoryOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [historyOpen]);

  progressRef.current = progress;

  // Tick while a run is live so headline + wall-clock total stay accurate.
  React.useEffect(() => {
    const live =
      busy ||
      progress.some((line) => line.status === "active") ||
      runStartedAtRef.current !== null;
    if (!live) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [busy, progress]);

  const refreshMessages = React.useCallback(async (id: string) => {
    const result = await getAgentMessages(id);
    setMessages(result.messages);
    return result;
  }, []);

  const applyTerminalRunStatus = React.useCallback((run: AgentRun) => {
    const fromServer = agentRunDurationMs(run.startedAt, run.completedAt);
    const fromClient =
      runStartedAtRef.current !== null
        ? Math.max(0, Date.now() - runStartedAtRef.current)
        : null;
    const ms = fromServer ?? fromClient;

    if (run.status === "failed") {
      setRunError("The agent run failed. You can try again.");
      setRunNotice(null);
      setCanRetryRun(true);
    } else if (run.status === "cancelled") {
      setRunError(null);
      setRunNotice(null);
      setCanRetryRun(false);
    } else if (run.status === "completed") {
      setRunError(null);
      setRunNotice(null);
      setCanRetryRun(false);
    } else {
      setRunError(null);
      setRunNotice(null);
      setCanRetryRun(false);
    }
    setPendingConfirmation(null);

    if (!isActiveAgentRunStatus(run.status)) {
      if (ms !== null) {
        setRunTotalMs(ms);
        const outcome =
          run.status === "cancelled"
            ? "cancelled"
            : run.status === "failed"
              ? "failed"
              : "completed";
        setLastTurn({
          runId: run.id,
          durationMs: ms,
          lines: progressRef.current,
          outcome,
        });
      }
      runIdRef.current = null;
      reconnectAttemptsRef.current = 0;
      runStartedAtRef.current = null;
      // Keep lastTurn for expandable details; collapse primary execution UX.
      setTimelineOpen(false);
      setProgress([]);
    }
  }, []);

  const finalizeFromSnapshot = React.useCallback(
    async (runId: string, thread: string) => {
      if (runIdRef.current !== runId) {
        return null;
      }
      const snapshot = await getAgentRun(runId);
      if (runIdRef.current !== runId) {
        return null;
      }
      setActiveRun(snapshot.run);
      const refreshed = await refreshMessages(thread);
      // Keep liveDraft until durable assistant text is present (avoids a blank flash).
      const hasAssistant = refreshed.messages.some(
        (message) => message.role === "assistant" && message.content.length > 0,
      );
      if (hasAssistant || !isActiveAgentRunStatus(snapshot.run.status)) {
        setLiveDraft(null);
      }
      applyTerminalRunStatus(snapshot.run);
      return snapshot.run;
    },
    [applyTerminalRunStatus, refreshMessages],
  );

  /** Clear busy UI when SSE dies and the run is no longer live (abandoned). */
  const abandonLiveRun = React.useCallback(
    async (runId: string, thread: string, message: string) => {
      stopSse();
      try {
        await cancelAgentRun(runId);
      } catch {
        // Best-effort — run may already be gone or not cancellable.
      }
      if (runIdRef.current !== runId) {
        return;
      }
      setRunError(message);
      setRunNotice(null);
      setCanRetryRun(true);
      setPendingConfirmation(null);
      setConfirmationError(null);
      setConfirmingDecision(false);
      setActiveRun(null);
      runIdRef.current = null;
      reconnectAttemptsRef.current = 0;
      runStartedAtRef.current = null;
      setProgress([]);
      setLiveDraft(null);
      setTimelineOpen(false);
      await refreshMessages(thread).catch(() => undefined);
    },
    [refreshMessages, stopSse],
  );

  const attachRunRef = React.useRef<(
    run: AgentRun,
    thread: string,
    options?: { preserveDraft?: boolean },
  ) => void>(() => undefined);

  const attachRun = React.useCallback(
    (run: AgentRun, thread: string, options?: { preserveDraft?: boolean }) => {
      stopSse();
      const generation = sseGenerationRef.current;
      runIdRef.current = run.id;
      setActiveRun(run);
      setRunError(null);
      setRunNotice(null);
      if (!options?.preserveDraft) {
        setCanRetryRun(false);
        setPendingConfirmation(null);
        setConfirmationError(null);
        setConfirmingDecision(false);
        setLiveDraft(null);
        reconnectAttemptsRef.current = 0;
        const startedAt = Date.now();
        runStartedAtRef.current = startedAt;
        setRunTotalMs(null);
        setLastTurn(null);
        // Collapsed by default (Perplexity-style); click › to expand steps.
        setTimelineOpen(false);
        setProgress([
          {
            id: "thinking",
            label: "Thinking…",
            status: "active",
            startedAt,
          },
        ]);
      }

      if (!isActiveAgentRunStatus(run.status)) {
        void finalizeFromSnapshot(run.id, thread);
        return;
      }

      const isCurrent = () =>
        sseGenerationRef.current === generation && runIdRef.current === run.id;

      const sub = subscribeAgentRunEvents(run.id, {
        onEvent: (event) => {
          if (!isCurrent()) return;
          setProgress((prev) => reduceAgentProgress(prev, event));

          if (event.type === "message.started") {
            const messageId = String(event.data.messageId ?? "");
            if (messageId) {
              setLiveDraft({ messageId, content: "" });
            }
          } else if (event.type === "message.delta") {
            const messageId = String(event.data.messageId ?? "");
            const delta = String(event.data.delta ?? "");
            if (messageId && delta) {
              // Keep the Thought/Generating block visible (Cursor-style).
              // Do not auto-collapse the timeline when tokens start.
              setLiveDraft((prev) => {
                if (prev && prev.messageId === messageId) {
                  return { messageId, content: prev.content + delta };
                }
                return { messageId, content: delta };
              });
            }
          } else if (event.type === "message.completed") {
            const messageId = String(event.data.messageId ?? "");
            const content = String(event.data.content ?? "");
            if (messageId) {
              setLiveDraft({ messageId, content });
            }
          } else if (event.type === "confirmation.required") {
            setConfirmationError(null);
            setPendingConfirmation({
              toolCallId: String(event.data.toolCallId ?? ""),
              toolName: String(event.data.toolName ?? "this action"),
              reason: String(event.data.reason ?? ""),
            });
          } else if (event.type === "document.version.advanced") {
            const advancedDocumentId = String(event.data.documentId ?? "");
            if (advancedDocumentId) {
              scheduleDocumentVersionRefresh(advancedDocumentId);
              const rawVersion = event.data.versionNumber;
              const versionNumber =
                typeof rawVersion === "number" ? rawVersion : Number(rawVersion);
              if (documentId && advancedDocumentId === documentId && Number.isFinite(versionNumber)) {
                setVersionNotice({ documentId: advancedDocumentId, versionNumber });
              }
            }
          } else if (event.type === "document.created") {
            const createdId = String(event.data.documentId ?? "");
            if (createdId) {
              void getDocument(createdId)
                .then((fresh) => {
                  onDocumentCreated?.(fresh);
                  setWorkspaceFiles((prev) => {
                    if (prev.some((file) => file.id === fresh.id)) {
                      return prev.map((file) =>
                        file.id === fresh.id ? fresh : file,
                      );
                    }
                    return [fresh, ...prev];
                  });
                  router.push(documentPath(workspaceId, fresh.id));
                })
                .catch(() => undefined);
            }
          }

          if (
            event.type === "tool.started" ||
            event.type === "tool.failed" ||
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            // Confirmation is resolved (approved/denied) once the tool
            // starts, fails, or the run ends — server decides synchronously.
            setPendingConfirmation(null);
            setConfirmingDecision(false);
            setConfirmationError(null);
          }

          if (
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            flushDocumentVersionRefresh();
            stopSse();
            void finalizeFromSnapshot(run.id, thread);
          }
        },
        onDisconnect: () => {
          if (!isCurrent()) return;
          void (async () => {
            try {
              const snapshot = await getAgentRun(run.id);
              if (!isCurrent()) return;
              setActiveRun(snapshot.run);
              if (!isActiveAgentRunStatus(snapshot.run.status)) {
                await finalizeFromSnapshot(run.id, thread);
                return;
              }
              // Stream dropped while durable status is still live — retry SSE a
              // couple of times with backoff. Never tight-poll GET /runs (that
              // floods logs when the run was abandoned after a process crash).
              reconnectAttemptsRef.current += 1;
              if (reconnectAttemptsRef.current <= 2) {
                const attempt = reconnectAttemptsRef.current;
                window.setTimeout(() => {
                  if (!isCurrent()) return;
                  attachRunRef.current(snapshot.run, thread, {
                    preserveDraft: true,
                  });
                }, attempt * 400);
                return;
              }
              await abandonLiveRun(
                run.id,
                thread,
                "Lost connection to the agent run. It was interrupted — try again.",
              );
            } catch {
              if (!isCurrent()) return;
              await abandonLiveRun(
                run.id,
                thread,
                "Lost connection to the agent run. Refresh and try again.",
              );
            }
          })();
        },
        onError: () => {
          if (!isCurrent()) return;
          void (async () => {
            try {
              const snapshot = await getAgentRun(run.id);
              if (!isCurrent()) return;
              setActiveRun(snapshot.run);
              if (isActiveAgentRunStatus(snapshot.run.status)) {
                reconnectAttemptsRef.current += 1;
                if (reconnectAttemptsRef.current <= 2) {
                  const attempt = reconnectAttemptsRef.current;
                  window.setTimeout(() => {
                    if (!isCurrent()) return;
                    attachRunRef.current(snapshot.run, thread, {
                      preserveDraft: true,
                    });
                  }, attempt * 400);
                  return;
                }
                await abandonLiveRun(
                  run.id,
                  thread,
                  "Lost connection to the agent run. It was interrupted — try again.",
                );
                return;
              }
              await finalizeFromSnapshot(run.id, thread);
            } catch {
              if (!isCurrent()) return;
              await abandonLiveRun(
                run.id,
                thread,
                "Lost connection to the agent run. Refresh and try again.",
              );
            }
          })();
        },
      });
      sseAbortRef.current = sub.abort;
    },
    [
      abandonLiveRun,
      documentId,
      finalizeFromSnapshot,
      flushDocumentVersionRefresh,
      onDocumentCreated,
      onDocumentUpdated,
      refreshMessages,
      router,
      scheduleDocumentVersionRefresh,
      stopSse,
      workspaceId,
    ],
  );

  attachRunRef.current = attachRun;

  const load = React.useCallback(async () => {
    setPhase({ kind: "loading" });
    stopSse();
    setActiveRun(null);
    setProgress([]);
    setRunTotalMs(null);
    setLastTurn(null);
    setTimelineOpen(false);
    setRunError(null);
    setRunNotice(null);
    setCanRetryRun(false);
    setVersionNotice(null);
    setPendingConfirmation(null);
    setConfirmationError(null);
    setConfirmingDecision(false);
    runIdRef.current = null;
    runStartedAtRef.current = null;
    setLiveDraft(null);
    setHistoryOpen(false);
    reconnectAttemptsRef.current = 0;

    try {
      const [listed, files] = await Promise.all([
        listWorkspaceAgentThreads(workspaceId),
        listDocuments(workspaceId).catch(() => [] as ListedDocument[]),
      ]);
      setThreads(listed);
      setWorkspaceFiles(files);
      const latest = listed[0] ?? null;
      if (!latest) {
        setThreadId(null);
        setMessages([]);
        setPhase({ kind: "ready" });
        return;
      }

      setThreadId(latest.id);
      const { messages: history, latestRun } = await refreshMessages(latest.id);
      setMessages(history);
      setPhase({ kind: "ready" });

      if (latestRun && isActiveAgentRunStatus(latestRun.status)) {
        attachRunRef.current(latestRun, latest.id);
      } else if (latestRun && !isActiveAgentRunStatus(latestRun.status)) {
        const ms = agentRunDurationMs(latestRun.startedAt, latestRun.completedAt);
        if (ms !== null) {
          setRunTotalMs(ms);
          const outcome =
            latestRun.status === "cancelled"
              ? "cancelled"
              : latestRun.status === "failed"
                ? "failed"
                : "completed";
          setLastTurn({
            runId: latestRun.id,
            durationMs: ms,
            lines: [],
            outcome,
          });
          if (latestRun.status === "completed") {
            setRunNotice(null);
          } else if (latestRun.status === "cancelled") {
            setRunNotice(null);
          } else if (latestRun.status === "failed") {
            setCanRetryRun(true);
          }
        }
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: userFacingError(error, "Could not load the agent conversation."),
      });
    }
  }, [refreshMessages, stopSse, workspaceId]);

  React.useEffect(() => {
    void load();
    return () => {
      stopSse();
    };
  }, [load, stopSse]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onScroll() {
      if (!el) return;
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = remaining < 72;
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    // Smooth scroll for structural changes — not every streamed token.
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [
    messages.length,
    progress.length,
    liveDraft?.content.length,
    runError,
    runNotice,
    versionNotice,
    canRetryRun,
    pendingConfirmation,
    busy,
    runTotalMs,
    timelineOpen,
  ]);

  React.useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, 40), 160);
    el.style.height = `${next}px`;
  }, [draft]);

  function addTagged(file: TaggedDocument) {
    setTagged((prev) =>
      prev.some((item) => item.id === file.id) ? prev : [...prev, file],
    );
  }

  function removeTagged(id: string) {
    setTagged((prev) => prev.filter((item) => item.id !== id));
  }

  function resolveDocumentIdsForRun(): string[] {
    if (tagged.length > 0) {
      return tagged.map((file) => file.id);
    }
    if (documentId) {
      return [documentId];
    }
    return [];
  }

  function updateDraftAndMention(value: string) {
    setDraft(value);
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
    setDraft(replaced + after);
    addTagged({ id: file.id, name: file.name, format: file.format });
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => {
      el?.focus();
    });
  }

  const mentionMatches = React.useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.trim().toLowerCase();
    const taggedIds = new Set(tagged.map((file) => file.id));
    return workspaceFiles
      .filter((file) => !taggedIds.has(file.id))
      .filter((file) => (q ? file.name.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [mentionOpen, mentionQuery, tagged, workspaceFiles]);

  /**
   * Core "start a run" flow, shared by the composer submit and the Retry
   * affordance for a failed/interrupted run. Callers own draft handling.
   */
  async function submitInstruction(
    instruction: string,
    documentIds: string[],
    options?: { restoreDraftOnError?: boolean },
  ) {
    if (
      !shouldAcceptSubmit({
        instruction,
        busy,
        locked: submitLockRef.current,
      })
    ) {
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    setRunError(null);
    setRunNotice(null);
    setCanRetryRun(false);
    setVersionNotice(null);
    setPendingConfirmation(null);
    setConfirmationError(null);
    setConfirmingDecision(false);
    setMentionOpen(false);

    const optimisticId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "user",
        content: instruction,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      let id = threadId;
      if (!id) {
        const thread = await createWorkspaceAgentThread(workspaceId);
        id = thread.id;
        setThreadId(id);
        setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      }

      const run = await startAgentRun(id, instruction, { documentIds });
      const refreshed = await refreshMessages(id);
      setMessages(refreshed.messages);
      attachRun(run, id);
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      if (options?.restoreDraftOnError) {
        setDraft(instruction);
      }
      setRunError(
        userFacingError(error, "Could not start the agent run. Try again."),
      );
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  async function handleSubmit() {
    const instruction = draft.trim();
    if (
      !shouldAcceptSubmit({
        instruction,
        busy,
        locked: submitLockRef.current,
      })
    ) {
      return;
    }
    const documentIds = resolveDocumentIdsForRun();
    setDraft("");
    await submitInstruction(instruction, documentIds, {
      restoreDraftOnError: true,
    });
  }

  /**
   * Resubmits the last user message after a failed/interrupted run. Only
   * shown when `canRetryRun` is true, i.e. the message was already durably
   * persisted (so re-sending it is safe and unambiguous).
   */
  async function handleRetry() {
    if (busy) return;
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUserMessage) return;
    await submitInstruction(lastUserMessage.content, resolveDocumentIdsForRun());
  }

  /**
   * Approve or deny the currently pending confirmation. The run's own SSE
   * stream (tool.started / tool.failed) is the source of truth for what
   * happens next — this only submits the decision.
   */
  async function handleConfirmationDecision(decision: "approve" | "deny") {
    const runId = runIdRef.current ?? activeRun?.id;
    if (!runId || !pendingConfirmation || confirmingDecision) {
      return;
    }
    setConfirmingDecision(true);
    setConfirmationError(null);
    try {
      await resolveAgentConfirmation(runId, {
        toolCallId: pendingConfirmation.toolCallId,
        decision,
      });
      // Success: leave `confirmingDecision` true until the SSE
      // tool.started/tool.failed event clears `pendingConfirmation` — avoids
      // a flash of re-enabled buttons before the run actually moves on.
    } catch (error) {
      setConfirmingDecision(false);
      setConfirmationError(
        userFacingError(error, "Could not submit that decision. Try again."),
      );
    }
  }

  async function handleCancel() {
    const runId = runIdRef.current ?? activeRun?.id;
    if (!runId || cancelling) {
      return;
    }

    setCancelling(true);
    try {
      stopSse();
      const snapshot = await cancelAgentRun(runId);
      setActiveRun(snapshot.run);
      if (threadId) {
        await refreshMessages(threadId);
      }
      const nextProgress = reduceAgentProgress(progressRef.current, {
        id: 0,
        runId,
        type: "agent.cancelled",
        at: new Date().toISOString(),
        data: {},
      });
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      setLiveDraft(null);
      setPendingConfirmation(null);
      setConfirmationError(null);
      setConfirmingDecision(false);
      applyTerminalRunStatus(snapshot.run);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        setRunError("Run not found.");
      } else {
        setRunError(
          userFacingError(error, "Could not stop the agent run."),
        );
      }
      if (threadId && runId) {
        void finalizeFromSnapshot(runId, threadId);
      }
    } finally {
      setCancelling(false);
    }
  }

  async function handleSelectThread(nextId: string) {
    if (nextId === threadId || creatingChat) return;
    setHistoryOpen(false);
    stopSse();
    setActiveRun(null);
    setProgress([]);
    setLastTurn(null);
    setTimelineOpen(false);
    setRunTotalMs(null);
    setRunError(null);
    setRunNotice(null);
    setCanRetryRun(false);
    setVersionNotice(null);
    setPendingConfirmation(null);
    setConfirmationError(null);
    setConfirmingDecision(false);
    setLiveDraft(null);
    setDraft("");
    runIdRef.current = null;
    reconnectAttemptsRef.current = 0;
    setThreadId(nextId);
    setPhase({ kind: "loading" });
    try {
      const { messages: history, latestRun } = await refreshMessages(nextId);
      setMessages(history);
      setPhase({ kind: "ready" });
      if (latestRun && isActiveAgentRunStatus(latestRun.status)) {
        attachRun(latestRun, nextId);
      } else if (latestRun && !isActiveAgentRunStatus(latestRun.status)) {
        const ms = agentRunDurationMs(latestRun.startedAt, latestRun.completedAt);
        if (ms !== null) {
          setRunTotalMs(ms);
          setLastTurn({
            runId: latestRun.id,
            durationMs: ms,
            lines: [],
            outcome:
              latestRun.status === "cancelled"
                ? "cancelled"
                : latestRun.status === "failed"
                  ? "failed"
                  : "completed",
          });
          if (latestRun.status === "failed") {
            setCanRetryRun(true);
          }
        }
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: userFacingError(error, "Could not load that chat."),
      });
    }
  }

  async function handleNewChat() {
    if (phase.kind !== "ready" || creatingChat) {
      return;
    }

    setCreatingChat(true);
    setRunError(null);
    setRunNotice(null);
    setHistoryOpen(false);

    try {
      const runId = runIdRef.current ?? activeRun?.id;
      if (
        runId &&
        activeRun &&
        isActiveAgentRunStatus(activeRun.status)
      ) {
        stopSse();
        try {
          await cancelAgentRun(runId);
        } catch {
          // Still allow a fresh thread if cancel races with completion.
        }
      } else {
        stopSse();
      }

      const thread = await createWorkspaceAgentThread(workspaceId);
      setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      setThreadId(thread.id);
      setMessages([]);
      setActiveRun(null);
      setProgress([]);
      setLastTurn(null);
      setTimelineOpen(false);
      setRunTotalMs(null);
      setCanRetryRun(false);
      setVersionNotice(null);
      setPendingConfirmation(null);
      setConfirmationError(null);
      setConfirmingDecision(false);
      setLiveDraft(null);
      setDraft("");
      setTagged([]);
      runIdRef.current = null;
      reconnectAttemptsRef.current = 0;
      runStartedAtRef.current = null;
    } catch (error) {
      setRunError(
        userFacingError(error, "Could not start a new chat. Try again."),
      );
    } finally {
      setCreatingChat(false);
    }
  }

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
      void handleSubmit();
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show OpenSuite agent"
        aria-label="Show OpenSuite agent"
        className={cn(
          focusRingClass,
          "flex h-full w-10 shrink-0 flex-col items-center border-l border-line bg-sidebar pt-3",
        )}
      >
        <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[length:var(--text-2xs)] font-semibold text-accent hover:bg-primary-soft">
          AI
        </span>
      </button>
    );
  }

  const contextLabel =
    tagged.length > 0
      ? `${tagged.length} file${tagged.length === 1 ? "" : "s"} tagged`
      : documentName?.trim()
        ? `Working on ${documentName.trim()}`
        : "Workspace agent";
  const activeThread = threads.find((thread) => thread.id === threadId);
  const lastMessage = messages[messages.length - 1];
  const showLiveDraft = Boolean(
    liveDraft &&
      liveDraft.content.length > 0 &&
      lastMessage?.role !== "assistant",
  );
  const visibleProgress = visibleAgentProgress(progress);
  const liveHeadline = latestProgressHeadline(visibleProgress);
  const isLiveTurn = showLiveDraft || liveHeadline !== null || busy;
  const wallClockMs =
    runStartedAtRef.current !== null
      ? Math.max(0, nowTick - runStartedAtRef.current)
      : runTotalMs;
  // Stop whenever a run is in flight (state-driven so the composer re-renders).
  const canStop =
    !creatingChat &&
    (cancelling ||
      submitting ||
      (activeRun !== null && isActiveAgentRunStatus(activeRun.status)));
  const showRunProgressOnLastAssistant =
    !isLiveTurn &&
    lastTurn !== null &&
    lastMessage?.role === "assistant";
  // Always show run progress after a finished turn — even before the
  // durable assistant message lands (cancel / fail / brief gap).
  const showFinishedProgress =
    !isLiveTurn &&
    lastTurn !== null &&
    (showRunProgressOnLastAssistant || lastMessage?.role !== "assistant");
  const showEmpty =
    phase.kind === "ready" &&
    messages.length === 0 &&
    !isLiveTurn &&
    !runError &&
    !runNotice &&
    !versionNotice &&
    !canRetryRun;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-line bg-sidebar"
      style={{ width }}
    >
      <div className="os-workspace-rail relative flex items-center justify-between gap-2 bg-sidebar px-2.5">
        <div className="min-w-0 truncate text-[length:var(--text-sm)] font-semibold tracking-[-0.01em] text-ink">
          Agent
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
            <Button
              ref={historyAnchorRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setHistoryOpen((open) => !open)}
              disabled={phase.kind !== "ready" || threads.length === 0}
              title="Previous chats"
              aria-label="Previous chats"
              aria-expanded={historyOpen}
              aria-haspopup="menu"
              className="text-[length:var(--text-sm)] text-ink-faint"
            >
              ☰
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void handleNewChat()}
              disabled={phase.kind !== "ready" || creatingChat}
              title="New chat"
              aria-label="New chat"
              className="text-[length:var(--text-sm)] text-ink-faint"
            >
              +
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onToggle}
              title="Hide agent panel"
              aria-label="Hide agent panel"
              className="text-[length:var(--text-sm)] text-ink-faint"
            >
              ›
            </Button>
        </div>

        {historyOpen ? (
          <div
            ref={historyMenuRef}
            role="menu"
            aria-label="Previous chats"
            className="absolute left-2 right-2 top-[calc(100%+2px)] z-[var(--z-dropdown)] max-h-[240px] overflow-y-auto rounded-[var(--radius-md)] border border-line bg-surface py-1 shadow-[var(--elevation-sm)]"
          >
            <div className="px-2.5 py-1.5 text-[length:var(--text-2xs)] font-medium uppercase tracking-[0.04em] text-ink-faint">
              Previous chats
            </div>
            {threads.map((thread) => {
              const active = thread.id === threadId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  role="menuitem"
                  aria-current={active ? "true" : undefined}
                  onClick={() => void handleSelectThread(thread.id)}
                  className={cn(
                    focusRingClass,
                    "flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left hover:bg-primary-soft",
                    active && "bg-selected",
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-[length:var(--text-sm)]",
                      active ? "font-medium text-ink" : "text-ink-soft",
                    )}
                  >
                    {threadLabel(thread)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <p className="os-type-meta mb-3 truncate text-ink-faint">
          {activeThread ? threadLabel(activeThread) : contextLabel}
        </p>
        {phase.kind === "loading" ? (
          <p className="text-center text-[length:var(--text-xs)] text-ink-faint">
            Loading conversation…
          </p>
        ) : null}

        {phase.kind === "error" ? (
          <div className="text-center">
            <p className="mb-2 border-l-2 border-danger bg-danger-soft/60 px-2.5 py-2 text-left text-[length:var(--text-panel)] text-danger">
              {phase.message}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className={cn(
                focusRingClass,
                "rounded-[var(--radius-sm)] text-[length:var(--text-xs)] font-medium text-accent hover:underline",
              )}
            >
              Try again
            </button>
          </div>
        ) : null}

        {phase.kind === "ready" ? (
          <>
            {showEmpty ? (
              <div className="flex h-full min-h-[120px] items-center justify-center px-2 text-center">
                <p className="max-w-[240px] text-[length:var(--text-panel)] leading-relaxed text-ink-faint">
                  Ask OpenSuite to create or edit documents. Use @ to tag files,
                  or drag them from the explorer.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              {messages.map((message, index) => {
                const isLast = index === messages.length - 1;
                if (message.role === "user") {
                  return (
                    <div
                      key={message.id}
                      className="rounded-[var(--radius-md)] bg-secondary-soft px-2.5 py-2 text-[length:var(--text-panel)] leading-[1.55] text-ink"
                    >
                      {message.content}
                    </div>
                  );
                }
                return (
                  <div key={message.id} className="flex flex-col gap-1.5">
                    {isLast && showRunProgressOnLastAssistant && lastTurn ? (
                      <AgentRunProgress
                        presentation={presentAgentRun(lastTurn.lines, {
                          durationMs: lastTurn.durationMs,
                          outcome: lastTurn.outcome,
                        })}
                        status={
                          lastTurn.outcome === "failed" ? "error" : "done"
                        }
                        expanded={timelineOpen}
                        onToggle={() => setTimelineOpen((open) => !open)}
                      />
                    ) : null}
                    <AgentMarkdown text={message.content} />
                  </div>
                );
              })}

              {/* Live turn: compact progress above streaming answer. */}
              {isLiveTurn ? (
                <div className="flex flex-col gap-2">
                  <AgentRunProgress
                    presentation={presentAgentRun(visibleProgress, {
                      live: true,
                      streamingAnswer: Boolean(
                        liveDraft && liveDraft.content.length > 0,
                      ),
                    })}
                    status="active"
                    totalElapsed={
                      wallClockMs !== null
                        ? formatProgressElapsed(wallClockMs)
                        : null
                    }
                    expanded={timelineOpen}
                    onToggle={() => setTimelineOpen((open) => !open)}
                    live
                  />
                  {showLiveDraft && liveDraft ? (
                    <div className="relative">
                      <AgentMarkdown text={liveDraft.content} streaming />
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[0.85em] w-[2px] translate-y-[2px] animate-pulse bg-accent align-baseline"
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Finished turn with no assistant text yet (cancel / fail). */}
              {!isLiveTurn &&
              lastTurn &&
              showFinishedProgress &&
              !showRunProgressOnLastAssistant ? (
                <AgentRunProgress
                  presentation={presentAgentRun(lastTurn.lines, {
                    durationMs: lastTurn.durationMs,
                    outcome: lastTurn.outcome,
                  })}
                  status={lastTurn.outcome === "failed" ? "error" : "done"}
                  expanded={timelineOpen}
                  onToggle={() => setTimelineOpen((open) => !open)}
                />
              ) : null}

              {versionNotice ? (
                <p className="flex items-center gap-1.5 text-[length:var(--text-2xs)] text-ink-faint">
                  <span
                    aria-hidden
                    className="h-1 w-1 shrink-0 rounded-full bg-ink-faint/70"
                  />
                  Document updated to{" "}
                  <span className="font-medium tabular-nums text-ink-soft">
                    v{versionNotice.versionNumber}
                  </span>
                </p>
              ) : null}

              {runNotice ? (
                <p className="text-[length:var(--text-2xs)] text-ink-faint">
                  {runNotice}
                </p>
              ) : null}

              {runError ? (
                <div className="flex items-start gap-2 border-l-2 border-danger bg-danger-soft/50 px-2.5 py-2 text-[length:var(--text-panel)] text-danger">
                  <p className="min-w-0 flex-1 leading-snug">{runError}</p>
                  {canRetryRun ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRetry()}
                      disabled={busy}
                      className="h-6 shrink-0 border-danger/30 px-2 text-[length:var(--text-xs)] text-danger hover:bg-danger-soft"
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!runError && canRetryRun ? (
                <button
                  type="button"
                  onClick={() => void handleRetry()}
                  disabled={busy}
                  className={cn(
                    focusRingClass,
                    "self-start rounded-[var(--radius-sm)] text-[length:var(--text-xs)] font-medium text-accent hover:underline disabled:opacity-50",
                  )}
                >
                  Retry last request
                </button>
              ) : null}

              {activeRun && isActiveAgentRunStatus(activeRun.status) ? (
                <RunStatusHint
                  status={activeRun.status}
                  pendingConfirmation={pendingConfirmation}
                  confirming={confirmingDecision}
                  confirmationError={confirmationError}
                  onApprove={() => void handleConfirmationDecision("approve")}
                  onDeny={() => void handleConfirmationDecision("deny")}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line bg-sidebar px-3 py-2.5">
        <div
          className={cn(
            "os-composer rounded-[var(--radius-md)] border bg-surface p-2",
            dragOverComposer
              ? "border-primary border-dashed"
              : "border-line",
            canStop && "opacity-95",
          )}
          onDragOver={(event) => {
            if (
              event.dataTransfer.types.includes(OPENSUITE_DOCUMENT_DRAG_MIME)
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragOverComposer(true);
            }
          }}
          onDragLeave={() => setDragOverComposer(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOverComposer(false);
            const payload = parseDocumentDragPayload(
              event.dataTransfer.getData(OPENSUITE_DOCUMENT_DRAG_MIME),
            );
            if (!payload || payload.workspaceId !== workspaceId) return;
            addTagged({
              id: payload.id,
              name: payload.name,
              format: payload.format,
            });
          }}
        >
          {tagged.length > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {tagged.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  title="Remove tag"
                  aria-label={`Remove tag ${file.name}`}
                  onClick={() => removeTagged(file.id)}
                  className={cn(
                    focusRingClass,
                    "inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] bg-accent-soft px-1.5 py-0.5 text-[length:var(--text-2xs)] font-medium text-accent-hover",
                  )}
                >
                  <span className="truncate">@{file.name}</span>
                  <span className="opacity-60">×</span>
                </button>
              ))}
            </div>
          ) : null}
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
              disabled={canStop || phase.kind !== "ready"}
              onChange={(event) => updateDraftAndMention(event.target.value)}
              onKeyDown={onComposerKeyDown}
              aria-label="Message to agent"
              placeholder={
                canStop ? undefined : "Ask OpenSuite… (@ to tag a file)"
              }
              className={cn(
                focusRingClass,
                "max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-none bg-transparent text-[length:var(--text-panel)] leading-[1.5] text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint",
              )}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[length:var(--text-2xs)] tabular-nums text-ink-faint">
              {canStop && wallClockMs !== null
                ? formatProgressElapsed(wallClockMs)
                : null}
            </div>
            {canStop ? (
              <Button
                type="button"
                variant="primary"
                size="icon"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                title="Stop"
                aria-label="Stop agent run"
                className="shrink-0"
              >
                {cancelling ? (
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
                  busy || phase.kind !== "ready" || draft.trim().length === 0
                }
                onClick={() => void handleSubmit()}
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
    </aside>
  );
}

/**
 * Confirmation banner while a run waits for approve/deny.
 */
function RunStatusHint({
  status,
  pendingConfirmation,
  confirming,
  confirmationError,
  onApprove,
  onDeny,
}: {
  status: AgentRunStatus;
  pendingConfirmation: {
    toolCallId: string;
    toolName: string;
    reason: string;
  } | null;
  confirming: boolean;
  confirmationError: string | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  if (status !== "waiting_for_confirmation") {
    return null;
  }
  // The banner is only actionable once the toolCallId to approve/deny is
  // known — a bare `waiting_for_confirmation` snapshot (e.g. right after a
  // page reload, before the SSE event replays) has nothing to submit yet.
  const canAct = pendingConfirmation !== null;
  return (
    <div
      className="rounded-[var(--radius-md)] border border-accent-line bg-accent-soft/80 px-2.5 py-2.5"
      role="region"
      aria-label="Confirmation needed"
    >
      <p className="text-[length:var(--text-panel)] font-semibold tracking-[-0.01em] text-ink">
        Confirmation needed
        {pendingConfirmation?.toolName
          ? ` · ${pendingConfirmation.toolName}`
          : ""}
      </p>
      {pendingConfirmation?.reason ? (
        <p className="mt-1 text-[length:var(--text-panel)] leading-snug text-ink-soft">
          {pendingConfirmation.reason}
        </p>
      ) : (
        <p className="mt-1 text-[length:var(--text-xs)] text-ink-faint">
          The agent needs your decision before continuing.
        </p>
      )}
      {canAct ? (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onApprove}
            disabled={confirming}
            className="h-7 px-2.5 text-[length:var(--text-xs)]"
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDeny}
            disabled={confirming}
            className="h-7 px-2.5 text-[length:var(--text-xs)]"
          >
            Deny
          </Button>
          {confirming ? (
            <span className="text-[length:var(--text-2xs)] text-ink-faint">
              Submitting…
            </span>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-[length:var(--text-2xs)] text-ink-faint">
          Reconnecting to the pending confirmation…
        </p>
      )}
      {confirmationError ? (
        <p className="mt-1.5 text-[length:var(--text-2xs)] text-danger">
          {confirmationError}
        </p>
      ) : null}
    </div>
  );
}
