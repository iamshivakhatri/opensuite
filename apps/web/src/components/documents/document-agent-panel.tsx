"use client";

import * as React from "react";

import { userFacingError } from "@/components/files/format";
import {
  progressMarker,
  reduceAgentProgress,
  visibleAgentProgress,
  type AgentProgressLine,
} from "@/lib/agent-progress";
import { AgentMarkdown } from "@/lib/agent-markdown";
import { shouldAcceptSubmit } from "@/lib/agent-submit";
import {
  ApiError,
  cancelAgentRun,
  createDocumentAgentThread,
  getAgentMessages,
  getAgentRun,
  getDocument,
  isActiveAgentRunStatus,
  listDocumentAgentThreads,
  startAgentRun,
  subscribeAgentRunEvents,
  waitForAgentRunTerminal,
  type AgentMessage,
  type AgentRun,
  type AgentRunStatus,
  type AgentThread,
  type ListedDocument,
} from "@/lib/api";

type PanelPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

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
 * Document-scoped OpenSuite agent panel: durable thread/messages + live run UX.
 * When no document is open (workspace home), shows a select-a-file empty state.
 */
export function DocumentAgentPanel({
  documentId,
  documentName,
  collapsed,
  onToggle,
  width = 320,
  onDocumentUpdated,
}: {
  documentId: string | null;
  documentName?: string;
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  /** Fired when an agent run persists a newer document version. */
  onDocumentUpdated?: (document: ListedDocument) => void;
}) {
  const [phase, setPhase] = React.useState<PanelPhase>({ kind: "loading" });
  const [threads, setThreads] = React.useState<AgentThread[]>([]);
  const [threadId, setThreadId] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [draft, setDraft] = React.useState("");
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

  const refreshMessages = React.useCallback(async (id: string) => {
    const result = await getAgentMessages(id);
    setMessages(result.messages);
    return result;
  }, []);

  const applyTerminalRunStatus = React.useCallback((run: AgentRun) => {
    if (run.status === "failed") {
      setRunError("The agent run failed. You can try again.");
      setRunNotice(null);
    } else if (run.status === "cancelled") {
      setRunError(null);
      setRunNotice("Stopped");
    } else {
      setRunError(null);
      setRunNotice(null);
    }
    if (!isActiveAgentRunStatus(run.status)) {
      runIdRef.current = null;
      setProgress([]);
      reconnectAttemptsRef.current = 0;
    }
  }, []);

  const finalizeFromSnapshot = React.useCallback(
    async (runId: string, thread: string, waitForTerminal = false) => {
      if (runIdRef.current !== runId) {
        return null;
      }
      const snapshot = waitForTerminal
        ? await waitForAgentRunTerminal(runId)
        : await getAgentRun(runId);
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
        setProgress([{ id: "thinking", label: "Thinking…", status: "active" }]);
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
            if (
              advancedDocumentId &&
              documentId &&
              advancedDocumentId === documentId
            ) {
              void getDocument(advancedDocumentId)
                .then((fresh) => {
                  if (!isCurrent()) return;
                  onDocumentUpdated?.(fresh);
                })
                .catch(() => {
                  // Editor can still pick up the version on focus refresh.
                });
            }
          }

          if (
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            stopSse();
            void finalizeFromSnapshot(run.id, thread, false);
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
                await finalizeFromSnapshot(run.id, thread, false);
                return;
              }
              // Stream dropped while run is still live — re-subscribe instead of
              // immediately polling (polling was racing a healthy SSE and wiping drafts).
              reconnectAttemptsRef.current += 1;
              if (reconnectAttemptsRef.current <= 2) {
                attachRunRef.current(snapshot.run, thread, {
                  preserveDraft: true,
                });
                return;
              }
              await finalizeFromSnapshot(run.id, thread, true);
            } catch {
              if (!isCurrent()) return;
              await finalizeFromSnapshot(run.id, thread, true).catch(() => {
                setRunError("Lost connection to the agent run. Refreshing…");
                void refreshMessages(thread);
              });
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
                  attachRunRef.current(snapshot.run, thread, {
                    preserveDraft: true,
                  });
                  return;
                }
              }
              await finalizeFromSnapshot(run.id, thread, true);
            } catch {
              if (!isCurrent()) return;
              setRunError("Lost connection to the agent run. Refreshing…");
              void refreshMessages(thread);
            }
          })();
        },
      });
      sseAbortRef.current = sub.abort;
    },
    [documentId, finalizeFromSnapshot, onDocumentUpdated, refreshMessages, stopSse],
  );

  attachRunRef.current = attachRun;

  const load = React.useCallback(async () => {
    if (!documentId) {
      stopSse();
      setThreads([]);
      setThreadId(null);
      setMessages([]);
      setActiveRun(null);
      setProgress([]);
      setRunError(null);
      setRunNotice(null);
      setLiveDraft(null);
      setHistoryOpen(false);
      runIdRef.current = null;
      setPhase({ kind: "ready" });
      return;
    }

    setPhase({ kind: "loading" });
    stopSse();
    setActiveRun(null);
    setProgress([]);
    setRunError(null);
    setRunNotice(null);
    runIdRef.current = null;
    setLiveDraft(null);
    setHistoryOpen(false);
    reconnectAttemptsRef.current = 0;

    try {
      const listed = await listDocumentAgentThreads(documentId);
      setThreads(listed);
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
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: userFacingError(error, "Could not load the agent conversation."),
      });
    }
  }, [documentId, refreshMessages, stopSse]);

  React.useEffect(() => {
    void load();
    return () => {
      stopSse();
    };
  }, [documentId, load, stopSse]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, progress, runError, runNotice, busy, liveDraft]);

  React.useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, 40), 160);
    el.style.height = `${next}px`;
  }, [draft]);

  async function handleSubmit() {
    if (!documentId) return;
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
        const thread = await createDocumentAgentThread(documentId);
        id = thread.id;
        setThreadId(id);
        setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      }

      const run = await startAgentRun(id, instruction);
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
      setProgress((prev) =>
        reduceAgentProgress(prev, {
          id: 0,
          runId,
          type: "agent.cancelled",
          at: new Date().toISOString(),
          data: {},
        }),
      );
      setRunNotice("Stopped");
      setRunError(null);
      setLiveDraft(null);
      runIdRef.current = null;
      if (!isActiveAgentRunStatus(snapshot.run.status)) {
        setProgress([]);
      }
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
    if (!documentId || nextId === threadId || creatingChat) return;
    setHistoryOpen(false);
    stopSse();
    setActiveRun(null);
    setProgress([]);
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
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: userFacingError(error, "Could not load that chat."),
      });
    }
  }

  async function handleNewChat() {
    if (!documentId || phase.kind !== "ready" || creatingChat) {
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

      const thread = await createDocumentAgentThread(documentId);
      setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      setThreadId(thread.id);
      setMessages([]);
      setActiveRun(null);
      setProgress([]);
      setLiveDraft(null);
      setDraft("");
      runIdRef.current = null;
      reconnectAttemptsRef.current = 0;
    } catch (error) {
      setRunError(
        userFacingError(error, "Could not start a new chat. Try again."),
      );
    } finally {
      setCreatingChat(false);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
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

  if (!documentId) {
    return (
      <aside
        className="flex h-full shrink-0 flex-col border-l border-line bg-[var(--sidebar)]"
        style={{ width }}
      >
        <div className="shrink-0 border-b border-line px-3.5 pt-[15px] pb-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-semibold text-ink">OpenSuite</div>
            <button
              type="button"
              onClick={onToggle}
              title="Hide OpenSuite agent"
              className="grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink-soft"
            >
              ›
            </button>
          </div>
          <div className="mt-0.5 font-mono text-[8.5px] text-ink-faint">
            Workspace agent
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            Open a file from the explorer to chat about it. Cross-file working
            set comes next.
          </p>
        </div>
      </aside>
    );
  }

  const contextLabel = documentName?.trim() || "Document agent";
  const activeThread = threads.find((thread) => thread.id === threadId);
  const lastMessage = messages[messages.length - 1];
  const showLiveDraft = Boolean(
    liveDraft &&
      liveDraft.content.length > 0 &&
      lastMessage?.role !== "assistant",
  );
  // Status belongs *before* the answer — hide once text is on screen.
  // Keep completed tools (✓) + active Thinking so fast tools do not flicker.
  const visibleProgress = visibleAgentProgress(progress);
  const showProgress =
    visibleProgress.length > 0 &&
    !showLiveDraft &&
    !(lastMessage?.role === "assistant" && !busy);
  const showEmpty =
    phase.kind === "ready" &&
    messages.length === 0 &&
    !showProgress &&
    !showLiveDraft &&
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
            {busy && !creatingChat && activeRun && isActiveAgentRunStatus(activeRun.status) ? (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                title="Stop agent run"
                className="rounded-[8px] px-2 py-1 text-[10px] font-medium text-ink-soft hover:bg-sunken hover:text-ink disabled:opacity-50"
              >
                {cancelling ? "Stopping…" : "Stop"}
              </button>
            ) : null}
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
                  Ask OpenSuite to work with this document.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              {messages.map((message) =>
                message.role === "user" ? (
                  <div
                    key={message.id}
                    className="ml-6 rounded-[13px_13px_4px_13px] bg-ink px-3 py-2.5 text-[10.5px] leading-[1.6] text-on-ink shadow-[0_5px_18px_rgba(16,24,40,0.09)]"
                  >
                    {message.content}
                  </div>
                ) : (
                  <div key={message.id}>
                    <AgentMarkdown text={message.content} />
                  </div>
                ),
              )}

              {showProgress ? (
                <div className="rounded-[13px] border border-line bg-surface py-1 shadow-[0_1px_2px_rgba(16,24,40,0.025)]">
                  {visibleProgress.map((line) => (
                    <div
                      key={line.id}
                      className={`flex gap-2 px-3 py-1.5 font-mono text-[9.5px] leading-[1.45] ${
                        line.status === "done"
                          ? "text-ink-faint"
                          : "text-ink-soft"
                      }`}
                    >
                      <span
                        className={
                          line.status === "active"
                            ? "text-accent"
                            : line.status === "error"
                              ? "text-danger"
                              : line.status === "done"
                                ? "text-ink-faint"
                                : "text-accent"
                        }
                      >
                        {progressMarker(line.status)}
                      </span>
                      <span>{line.label}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {showLiveDraft && liveDraft ? (
                <div>
                  <AgentMarkdown text={liveDraft.content} />
                </div>
              ) : null}

              {runNotice ? (
                <p className="text-[10.5px] text-ink-faint">{runNotice}</p>
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
          className={`rounded-[13px] border border-line bg-surface p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.03)] focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--accent-soft)] ${
            busy ? "opacity-80" : ""
          }`}
        >
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            disabled={busy || phase.kind !== "ready"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Ask OpenSuite about this document…"
            className="max-h-40 min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent text-[11px] leading-[1.45] text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint"
          />
          <div className="mt-1 flex items-center justify-end">
            <button
              type="button"
              disabled={
                busy || phase.kind !== "ready" || draft.trim().length === 0
              }
              onClick={() => void handleSubmit()}
              title="Send"
              className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-[11px] text-on-ink hover:bg-accent-hover disabled:bg-accent-soft disabled:text-ink-faint"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </aside>
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
