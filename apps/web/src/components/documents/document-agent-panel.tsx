"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { userFacingError } from "@/components/files/format";
import {
  agentRunDurationMs,
  formatProgressElapsed,
  groupProgressLines,
  latestProgressHeadline,
  progressSummaryLabel,
  reduceAgentProgress,
  visibleAgentProgress,
  type AgentProgressLine,
  type AgentTurnProgress,
} from "@/lib/agent-progress";
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
import { documentPath } from "@/lib/paths";

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
      })
      .catch(() => {
        // Editor can still pick up the version on focus refresh.
      });
  }, [onDocumentUpdated]);

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
    } else if (run.status === "cancelled") {
      setRunError(null);
      setRunNotice(null);
    } else if (run.status === "completed") {
      setRunError(null);
      setRunNotice(null);
    } else {
      setRunError(null);
      setRunNotice(null);
    }

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
      // Keep lastTurn for expandable timeline; clear live progress.
      // Leave timelineOpen as the user left it (Cursor keeps Thought visible).
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
          } else if (event.type === "document.version.advanced") {
            const advancedDocumentId = String(event.data.documentId ?? "");
            if (advancedDocumentId) {
              scheduleDocumentVersionRefresh(advancedDocumentId);
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
  }, [messages.length, progress.length, liveDraft?.content.length, runError, runNotice, busy, runTotalMs, timelineOpen]);

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

    submitLockRef.current = true;
    setSubmitting(true);
    setRunError(null);
    setRunNotice(null);
    setDraft("");
    setMentionOpen(false);
    const documentIds = resolveDocumentIdsForRun();

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
      setDraft(instruction);
      setRunError(
        userFacingError(error, "Could not start the agent run. Try again."),
      );
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
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
        className="flex h-full w-10 shrink-0 flex-col items-center border-l border-line bg-[var(--sidebar)] pt-3"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[9px] text-[11px] font-semibold text-accent hover:bg-sunken">
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
  const isGenerating =
    liveHeadline?.id === "writing" || liveHeadline?.label === "Generating…";
  const timelineLines = isLiveTurn
    ? visibleProgress
    : lastTurn
      ? visibleAgentProgress(lastTurn.lines)
      : [];
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
  const showThoughtOnLastAssistant =
    !isLiveTurn &&
    lastTurn !== null &&
    lastMessage?.role === "assistant";
  // Always show a Thought block after a finished turn — even before the
  // durable assistant message lands (cancel / fail / brief gap).
  const showFinishedThought =
    !isLiveTurn &&
    lastTurn !== null &&
    (showThoughtOnLastAssistant || lastMessage?.role !== "assistant");
  const showEmpty =
    phase.kind === "ready" &&
    messages.length === 0 &&
    !isLiveTurn &&
    !runError &&
    !runNotice;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-line bg-[var(--sidebar)]"
      style={{ width }}
    >
      <div className="relative shrink-0 border-b border-line bg-[var(--sidebar)] px-3.5 pt-[15px] pb-3">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold text-ink">OpenSuite</div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setHistoryOpen((open) => !open)}
              disabled={phase.kind !== "ready" || threads.length === 0}
              title="Previous chats"
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink disabled:opacity-40"
            >
              ☰
            </button>
            <button
              type="button"
              onClick={() => void handleNewChat()}
              disabled={phase.kind !== "ready" || creatingChat}
              title="New chat"
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[14px] text-ink-faint hover:bg-sunken hover:text-ink disabled:opacity-40"
            >
              +
            </button>
            <button
              type="button"
              onClick={onToggle}
              title="Hide OpenSuite agent"
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink-soft"
            >
              ›
            </button>
          </div>
        </div>
        <div className="mt-0.5 truncate font-mono text-[8.5px] text-ink-faint">
          {activeThread ? threadLabel(activeThread) : contextLabel}
        </div>

        {historyOpen ? (
          <div className="absolute left-3 right-3 top-[calc(100%-4px)] z-20 max-h-[240px] overflow-y-auto rounded-[12px] border border-line bg-elevated py-1 shadow-[0_12px_40px_rgba(16,24,40,0.12)]">
            <div className="px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.08em] text-ink-faint">
              Previous chats
            </div>
            {threads.map((thread) => {
              const active = thread.id === threadId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => void handleSelectThread(thread.id)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-sunken ${
                    active ? "bg-selected" : ""
                  }`}
                >
                  <span
                    className={`truncate text-[11px] ${
                      active ? "font-medium text-accent" : "text-ink"
                    }`}
                  >
                    {threadLabel(thread)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
        {phase.kind === "loading" ? (
          <p className="text-center text-[11.5px] text-ink-faint">
            Loading conversation…
          </p>
        ) : null}

        {phase.kind === "error" ? (
          <div className="text-center">
            <p className="mb-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[11px] text-danger">
              {phase.message}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="text-[11px] font-medium text-accent hover:underline"
            >
              Try again
            </button>
          </div>
        ) : null}

        {phase.kind === "ready" ? (
          <>
            {showEmpty ? (
              <div className="flex h-full min-h-[120px] items-center justify-center px-3 text-center">
                <p className="text-[11.5px] leading-relaxed text-ink-faint">
                  Ask OpenSuite to create or edit documents. Use @ to tag files,
                  or drag them here from the explorer.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-3.5">
              {messages.map((message, index) => {
                const isLast = index === messages.length - 1;
                if (message.role === "user") {
                  return (
                    <div
                      key={message.id}
                      className="ml-6 rounded-[13px_13px_4px_13px] bg-ink px-3 py-2.5 text-[10.5px] leading-[1.6] text-on-ink shadow-[0_5px_18px_rgba(16,24,40,0.09)]"
                    >
                      {message.content}
                    </div>
                  );
                }
                return (
                  <div key={message.id} className="flex flex-col gap-1.5">
                    {isLast && showThoughtOnLastAssistant && lastTurn ? (
                      <AgentThoughtToggle
                        label={progressSummaryLabel(lastTurn.lines, {
                          durationMs: lastTurn.durationMs,
                          outcome: lastTurn.outcome,
                        })}
                        status={
                          lastTurn.outcome === "failed" ? "error" : "done"
                        }
                        expanded={timelineOpen}
                        onToggle={() => setTimelineOpen((open) => !open)}
                        timeline={timelineLines}
                        nowTick={nowTick}
                      />
                    ) : null}
                    <AgentMarkdown text={message.content} />
                  </div>
                );
              })}

              {/* Live turn: work header above streaming answer (Cursor order). */}
              {isLiveTurn ? (
                <div className="flex flex-col gap-2">
                  <AgentThoughtToggle
                    label={progressSummaryLabel(visibleProgress, {
                      live: true,
                    })}
                    status="active"
                    totalElapsed={
                      wallClockMs !== null
                        ? formatProgressElapsed(wallClockMs)
                        : null
                    }
                    expanded={timelineOpen}
                    onToggle={() => setTimelineOpen((open) => !open)}
                    timeline={timelineLines}
                    nowTick={nowTick}
                    live
                  />
                  {showLiveDraft && liveDraft ? (
                    <div className="relative">
                      <AgentMarkdown text={liveDraft.content} />
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
              showFinishedThought &&
              !showThoughtOnLastAssistant ? (
                <AgentThoughtToggle
                  label={progressSummaryLabel(lastTurn.lines, {
                    durationMs: lastTurn.durationMs,
                    outcome: lastTurn.outcome,
                  })}
                  status={lastTurn.outcome === "failed" ? "error" : "done"}
                  expanded={timelineOpen}
                  onToggle={() => setTimelineOpen((open) => !open)}
                  timeline={timelineLines}
                  nowTick={nowTick}
                />
              ) : null}

              {runNotice ? (
                <p className="px-0.5 text-[10px] text-ink-faint">{runNotice}</p>
              ) : null}

              {runError ? (
                <p className="rounded-[var(--radius-sm)] bg-danger-soft px-2.5 py-2 text-[10.5px] text-danger">
                  {runError}
                </p>
              ) : null}

              {activeRun && isActiveAgentRunStatus(activeRun.status) ? (
                <RunStatusHint status={activeRun.status} />
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line bg-sidebar p-3">
        <div
          className={`rounded-[13px] border bg-surface p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.03)] focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--accent-soft)] ${
            dragOverComposer
              ? "border-accent border-dashed"
              : "border-line"
          }`}
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
            <div className="mb-2 flex flex-wrap gap-1">
              {tagged.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  title="Remove tag"
                  onClick={() => removeTagged(file.id)}
                  className="inline-flex max-w-full items-center gap-1 rounded-[7px] bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-hover"
                >
                  <span className="truncate">@{file.name}</span>
                  <span className="opacity-60">×</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="relative">
            {mentionOpen && mentionMatches.length > 0 ? (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[180px] overflow-y-auto rounded-[10px] border border-line bg-elevated py-1 shadow-[0_12px_40px_rgba(16,24,40,0.12)]">
                {mentionMatches.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => applyMention(file)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-ink hover:bg-sunken"
                  >
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 font-mono text-[8px] uppercase text-ink-faint">
                      {file.format}
                    </span>
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
              placeholder={
                canStop
                  ? "Agent is working… press Stop to cancel"
                  : "Ask OpenSuite… (@ to tag a file)"
              }
              className="max-h-40 min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent text-[11px] leading-[1.45] text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint"
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[10px] tabular-nums text-ink-faint">
              {canStop && wallClockMs !== null
                ? `${isGenerating ? "Generating" : "Working"} · ${formatProgressElapsed(wallClockMs)}`
                : null}
            </div>
            {canStop ? (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                title="Stop"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-ink text-on-ink hover:opacity-90 disabled:opacity-50"
              >
                {cancelling ? (
                  <span className="text-[10px]">…</span>
                ) : (
                  <span className="block h-[10px] w-[10px] rounded-[1.5px] bg-on-ink" />
                )}
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  busy || phase.kind !== "ready" || draft.trim().length === 0
                }
                onClick={() => void handleSubmit()}
                title="Send"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-accent text-[11px] text-on-ink hover:bg-accent-hover disabled:bg-accent-soft disabled:text-ink-faint"
              >
                ➤
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * Perplexity-style work summary: one compact line, click to expand grouped steps.
 * Repeated tools collapse (e.g. "Inserted paragraphs · 13").
 */
function AgentThoughtToggle({
  label,
  status,
  totalElapsed,
  expanded,
  onToggle,
  timeline,
  live = false,
}: {
  label: string;
  status: AgentProgressLine["status"];
  totalElapsed?: string | null;
  expanded: boolean;
  onToggle: () => void;
  timeline: readonly AgentProgressLine[];
  nowTick?: number;
  live?: boolean;
}) {
  const groups = groupProgressLines(timeline);
  const hasTimeline = groups.length > 0;
  const isActive = status === "active" || live;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={hasTimeline ? onToggle : undefined}
        disabled={!hasTimeline}
        className={`group flex max-w-full items-center gap-1.5 rounded-[8px] py-0.5 text-left text-[11.5px] leading-[1.45] transition-colors ${
          hasTimeline ? "cursor-pointer hover:opacity-80" : "cursor-default"
        } ${
          status === "error"
            ? "text-danger"
            : isActive
              ? "text-accent"
              : "text-ink-faint"
        }`}
        title={
          hasTimeline
            ? expanded
              ? "Hide steps"
              : "Show steps"
            : undefined
        }
      >
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        ) : status === "error" ? (
          <span className="shrink-0 text-[10px]">!</span>
        ) : null}
        <span className="min-w-0 truncate font-medium">{label}</span>
        {totalElapsed && isActive ? (
          <span className="shrink-0 tabular-nums text-[10.5px] opacity-70">
            · {totalElapsed}
          </span>
        ) : null}
        {hasTimeline ? (
          <span
            className={`shrink-0 text-[10px] opacity-60 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          >
            ›
          </span>
        ) : null}
      </button>

      {expanded && hasTimeline ? (
        <div className="ml-3.5 mt-1.5 space-y-0.5 border-l border-line/80 pl-3">
          {groups.map((group, index) => (
            <div
              key={`${group.key}:${index}`}
              className={`flex items-baseline gap-2 py-[2px] text-[11px] leading-[1.4] ${
                group.status === "error"
                  ? "text-danger"
                  : group.status === "active"
                    ? "text-ink-soft"
                    : "text-ink-faint"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                {group.label}
                {group.count > 1 ? (
                  <span className="opacity-70"> · {group.count}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunStatusHint({ status }: { status: AgentRunStatus }) {
  if (status === "waiting_for_confirmation") {
    return (
      <p className="text-[10px] text-ink-faint">
        Waiting for confirmation…
      </p>
    );
  }
  return null;
}
