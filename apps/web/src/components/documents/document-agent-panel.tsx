"use client";

import * as React from "react";

import { userFacingError } from "@/components/files/format";
import {
  progressMarker,
  reduceAgentProgress,
  type AgentProgressLine,
} from "@/lib/agent-progress";
import { shouldAcceptSubmit } from "@/lib/agent-submit";
import {
  ApiError,
  cancelAgentRun,
  createDocumentAgentThread,
  getAgentMessages,
  getAgentRun,
  isActiveAgentRunStatus,
  listDocumentAgentThreads,
  startAgentRun,
  subscribeAgentRunEvents,
  type AgentMessage,
  type AgentRun,
  type AgentRunStatus,
} from "@/lib/api";

type PanelPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/**
 * Document-scoped OpenSuite agent panel: durable thread/messages + live run UX.
 * Preserves the existing shell chrome; wires composer/progress/cancel.
 */
export function DocumentAgentPanel({
  documentId,
  documentName,
  collapsed,
  onToggle,
}: {
  documentId: string;
  documentName?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [phase, setPhase] = React.useState<PanelPhase>({ kind: "loading" });
  const [threadId, setThreadId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [activeRun, setActiveRun] = React.useState<AgentRun | null>(null);
  const [progress, setProgress] = React.useState<AgentProgressLine[]>([]);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runNotice, setRunNotice] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sseAbortRef = React.useRef<(() => void) | null>(null);
  const runIdRef = React.useRef<string | null>(null);
  const submitLockRef = React.useRef(false);

  const busy =
    submitting ||
    cancelling ||
    (activeRun !== null && isActiveAgentRunStatus(activeRun.status));

  const stopSse = React.useCallback(() => {
    sseAbortRef.current?.();
    sseAbortRef.current = null;
  }, []);

  const refreshMessages = React.useCallback(async (id: string) => {
    const result = await getAgentMessages(id);
    setMessages(result.messages);
    return result;
  }, []);

  const finalizeFromSnapshot = React.useCallback(
    async (runId: string, thread: string) => {
      const snapshot = await getAgentRun(runId);
      setActiveRun(snapshot.run);
      await refreshMessages(thread);

      if (snapshot.run.status === "failed") {
        setRunError("The agent run failed. You can try again.");
        setRunNotice(null);
      } else if (snapshot.run.status === "cancelled") {
        setRunError(null);
        setRunNotice("Stopped");
      } else {
        setRunError(null);
        setRunNotice(null);
      }

      if (!isActiveAgentRunStatus(snapshot.run.status)) {
        runIdRef.current = null;
        setProgress([]);
      }

      return snapshot.run;
    },
    [refreshMessages],
  );

  const attachRun = React.useCallback(
    (run: AgentRun, thread: string) => {
      stopSse();
      runIdRef.current = run.id;
      setActiveRun(run);
      setRunError(null);
      setRunNotice(null);
      setProgress([{ id: "working", label: "Working…", status: "active" }]);

      if (!isActiveAgentRunStatus(run.status)) {
        void finalizeFromSnapshot(run.id, thread);
        return;
      }

      const sub = subscribeAgentRunEvents(run.id, {
        onEvent: (event) => {
          setProgress((prev) => reduceAgentProgress(prev, event));
          if (
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            stopSse();
            void finalizeFromSnapshot(run.id, thread);
          }
        },
        onDisconnect: () => {
          // Do not assume failure — recover from durable snapshot.
          void finalizeFromSnapshot(run.id, thread);
        },
        onError: () => {
          void finalizeFromSnapshot(run.id, thread).catch(() => {
            setRunError("Lost connection to the agent run. Refreshing…");
            void refreshMessages(thread);
          });
        },
      });
      sseAbortRef.current = sub.abort;
    },
    [finalizeFromSnapshot, refreshMessages, stopSse],
  );

  const load = React.useCallback(async () => {
    setPhase({ kind: "loading" });
    stopSse();
    setActiveRun(null);
    setProgress([]);
    setRunError(null);
    setRunNotice(null);
    runIdRef.current = null;

    try {
      const threads = await listDocumentAgentThreads(documentId);
      const latest = threads[0] ?? null;
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
        attachRun(latestRun, latest.id);
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: userFacingError(error, "Could not load the agent conversation."),
      });
    }
  }, [attachRun, documentId, refreshMessages, stopSse]);

  React.useEffect(() => {
    void load();
    return () => {
      stopSse();
    };
  }, [load, stopSse]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, progress, runError, runNotice, busy]);

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
        className="flex h-full w-10 shrink-0 flex-col items-center border-l border-line bg-[#FAFAFC] pt-3"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[9px] text-[13px] text-accent hover:bg-sunken">
          ✦
        </span>
      </button>
    );
  }

  const contextLabel = documentName?.trim() || "Document agent";
  const showEmpty =
    phase.kind === "ready" &&
    messages.length === 0 &&
    progress.length === 0 &&
    !runError &&
    !runNotice;

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-[#FAFAFC]">
      <div className="shrink-0 border-b border-[#E5E7EB] bg-[#FAFAFC] px-3.5 pt-[15px] pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <span className="text-accent">✦</span> OpenSuite
          </div>
          <div className="flex items-center gap-1">
            {busy ? (
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
        <div className="mt-0.5 truncate font-mono text-[8.5px] text-[#989DA7]">
          {contextLabel}
        </div>
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
                    className="ml-6 rounded-[13px_13px_4px_13px] bg-[#22252B] px-3 py-2.5 text-[10.5px] leading-[1.6] text-[#F8F9FB] shadow-[0_5px_18px_rgba(16,24,40,0.09)]"
                  >
                    {message.content}
                  </div>
                ) : (
                  <div key={message.id}>
                    <div className="mb-1 text-[9px] text-[#969BA6]">
                      ✦ OpenSuite · Document
                    </div>
                    <div className="whitespace-pre-wrap text-[11px] leading-[1.6] text-[#43474F]">
                      {message.content}
                    </div>
                  </div>
                ),
              )}

              {progress.length > 0 ? (
                <div className="rounded-[13px] border border-[#E3E5EA] bg-white py-1 shadow-[0_1px_2px_rgba(16,24,40,0.025)]">
                  {progress.map((line) => (
                    <div
                      key={line.id}
                      className="flex gap-2 px-3 py-1.5 font-mono text-[9.5px] leading-[1.45] text-[#6F7580]"
                    >
                      <span
                        className={
                          line.status === "active"
                            ? "text-accent"
                            : line.status === "error"
                              ? "text-danger"
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

      <div className="shrink-0 border-t border-[#E4E6EA] bg-[#F8F9FB] p-3">
        <div
          className={`rounded-[13px] border border-[#DEE1E7] bg-white p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.03)] focus-within:border-[#C7C8F8] focus-within:shadow-[0_0_0_3px_rgba(91,92,226,0.08)] ${
            busy ? "opacity-80" : ""
          }`}
        >
          <textarea
            rows={2}
            value={draft}
            disabled={busy || phase.kind !== "ready"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Ask OpenSuite about this document…"
            className="w-full resize-none border-none bg-transparent text-[11px] leading-[1.45] text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint"
          />
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] text-ink-faint">＋ Add context</span>
            <button
              type="button"
              disabled={
                busy || phase.kind !== "ready" || draft.trim().length === 0
              }
              onClick={() => void handleSubmit()}
              title="Send"
              className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-[11px] text-white hover:bg-accent-hover disabled:bg-[#C6C7F5] disabled:text-white"
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
