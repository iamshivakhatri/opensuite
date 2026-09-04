/**
 * Structural shell for the OpenSuite agent panel. No agent functionality:
 * no messages, no LLM calls, no persisted conversation. The composer is
 * present but disabled so it cannot misleadingly imply the agent works yet.
 */
export function DocumentAgentPanel({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
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

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-[#FAFAFC]">
      <div className="shrink-0 border-b border-[#E5E7EB] bg-[#FAFAFC] px-3.5 pt-[15px] pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <span className="text-accent">✦</span> OpenSuite
          </div>
          <button
            type="button"
            onClick={onToggle}
            title="Hide OpenSuite agent"
            className="grid h-7 w-7 place-items-center rounded-[8px] text-[12px] text-ink-faint hover:bg-sunken hover:text-ink-soft"
          >
            ›
          </button>
        </div>
        <div className="mt-0.5 truncate font-mono text-[8.5px] text-[#989DA7]">
          Workspace agent
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-7 text-center">
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Ask OpenSuite to work with this document.
        </p>
      </div>

      <div className="shrink-0 border-t border-[#E4E6EA] bg-[#F8F9FB] p-3">
        <div className="cursor-not-allowed rounded-[13px] border border-[#DEE1E7] bg-white p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
          <textarea
            disabled
            rows={2}
            placeholder="Ask OpenSuite about this document…"
            className="w-full cursor-not-allowed resize-none border-none bg-transparent text-[11px] leading-[1.45] text-ink-faint outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] text-ink-faint">＋ Add context</span>
            <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[#C6C7F5] text-[11px] text-white">
              ➤
            </span>
          </div>
        </div>
        <p className="mt-2 text-center text-[9.5px] text-ink-faint">
          Coming soon
        </p>
      </div>
    </aside>
  );
}
