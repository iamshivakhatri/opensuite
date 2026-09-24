/**
 * Static, faithful representation of the OpenSuite workspace — built from
 * the same surface/border/accent tokens as the real app shell (sidebar,
 * document canvas, agent panel), not a fabricated interface. Presentational
 * only: no interactivity, no real data.
 */
export function ProductPreview() {
  return (
    <div
      className="os-theme-dark relative mx-auto w-full max-w-5xl overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.3),0_40px_100px_rgba(0,0,0,0.55)]"
      aria-hidden
    >
      {/* Top rail */}
      <div className="flex h-10 items-center gap-3 border-b border-line bg-surface px-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-line" />
          <span className="h-2.5 w-2.5 rounded-full bg-line" />
          <span className="h-2.5 w-2.5 rounded-full bg-line" />
        </div>
        <div className="flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] bg-primary-soft px-2.5 text-[11px] font-medium text-primary">
          Quarterly-Plan.docx
        </div>
        <div className="h-6 rounded-[var(--radius-sm)] px-2.5 text-[11px] leading-6 text-ink-faint">
          Onboarding-Guide.docx
        </div>
      </div>

      <div className="flex h-[420px]">
        {/* Sidebar */}
        <div className="hidden w-[168px] shrink-0 flex-col gap-4 border-r border-line bg-sidebar px-2.5 py-3 sm:flex">
          <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
            <span>⌕</span>
            <span>Search</span>
          </div>
          <div className="flex flex-col gap-1">
            {["Home", "Recent", "Starred", "Trash"].map((label, i) => (
              <div
                key={label}
                className={
                  "rounded-[var(--radius-sm)] px-2 py-1.5 text-[11px] " +
                  (i === 0
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-ink-soft")
                }
              >
                {label}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Workspaces
            </div>
            <div className="rounded-[var(--radius-sm)] bg-accent-soft px-2 py-1.5 text-[11px] font-medium text-primary">
              Product Team
            </div>
            <div className="px-2 py-1.5 text-[11px] text-ink-soft">
              Personal
            </div>
          </div>
        </div>

        {/* Document canvas */}
        <div className="flex-1 overflow-hidden bg-[var(--canvas)] px-6 py-6">
          <div className="mx-auto max-w-[380px] rounded-[2px] bg-white px-7 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.25),0_16px_40px_rgba(0,0,0,0.35)]">
            <div className="mb-3 h-3 w-2/3 rounded-full bg-[#1f2430]/85" />
            <div className="space-y-1.5">
              <div className="h-2 w-full rounded-full bg-[#1f2430]/20" />
              <div className="h-2 w-full rounded-full bg-[#1f2430]/20" />
              <div className="h-2 w-4/5 rounded-full bg-[#1f2430]/20" />
            </div>
            <div className="mt-3.5 rounded-[3px] bg-primary/10 px-2 py-1.5 ring-1 ring-primary/30">
              <div className="h-2 w-3/4 rounded-full bg-primary/50" />
            </div>
            <div className="mt-3.5 space-y-1.5">
              <div className="h-2 w-full rounded-full bg-[#1f2430]/20" />
              <div className="h-2 w-2/3 rounded-full bg-[#1f2430]/20" />
            </div>
          </div>
        </div>

        {/* Agent panel */}
        <div className="hidden w-[240px] shrink-0 flex-col border-l border-line bg-surface p-3 lg:flex">
          <div className="mb-3 text-[11px] font-medium text-ink-soft">
            Agent
          </div>
          <div className="flex-1 space-y-2.5 overflow-hidden">
            <div className="ml-6 rounded-[var(--radius-md)] bg-secondary-soft px-2.5 py-2 text-[11px] leading-relaxed text-ink">
              Update the budget table on page 2 and tighten the summary.
            </div>
            <div className="space-y-1.5 rounded-[var(--radius-md)] border border-line px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft">
              <div className="flex items-center gap-1.5 text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Inspecting document
              </div>
              <div className="flex items-center gap-1.5 text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Editing table · Row 4
              </div>
              <p className="text-ink-soft">
                Updated the Q3 figures and shortened the summary paragraph.
              </p>
            </div>
          </div>
          <div className="mt-3 rounded-[var(--radius-md)] border border-line bg-[var(--paper)] px-2.5 py-2 text-[11px] text-ink-faint">
            Ask OpenSuite… (@ to tag a file)
          </div>
        </div>
      </div>
    </div>
  );
}
