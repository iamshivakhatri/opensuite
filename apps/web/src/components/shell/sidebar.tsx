const navItems = [
  { icon: "▦", label: "All Files", active: true },
  { icon: "◷", label: "Recent" },
  { icon: "☆", label: "Starred" },
  { icon: "⌘", label: "Shared" },
];

const appFilters = [
  {
    label: "Write",
    icon: (
      <path d="M4 19h4l10-10a2.2 2.2 0 0 0-3-3L5 16v3z" />
    ),
  },
  {
    label: "Slides",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="12" rx="1.5" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    ),
  },
  {
    label: "Sheets",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="1.5" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="10.5" y1="3" x2="10.5" y2="21" />
      </>
    ),
  },
];

/**
 * Workspace sidebar from opensuite_v4_modern_minimal.html.
 * All Files is the active product surface; other items remain visual placeholders.
 */
export function Sidebar() {
  return (
    <aside className="flex w-[236px] shrink-0 flex-col gap-5 border-r border-line bg-[#F8F9FB] px-2.5 py-4">
      <div>
        <div className="mb-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-[#9A9FAA]">
          Workspace
        </div>
        <div className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <div
              key={item.label}
              className={
                "flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[12px] transition-colors " +
                (item.active
                  ? "bg-[#EDEEFF] font-semibold text-[#4D4ED0] shadow-[inset_0_0_0_1px_rgba(91,92,226,0.05)]"
                  : "text-[#666C77] hover:bg-[#EEF0F4] hover:text-[#25282F]")
              }
            >
              <span
                className={
                  "w-4 text-center text-[13px] " +
                  (item.active ? "text-[#5B5CE2]" : "text-[#959AA5]")
                }
              >
                {item.icon}
              </span>
              {item.label}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-[#9A9FAA]">
          Apps
        </div>
        <div className="grid grid-cols-3 gap-[7px] px-0.5">
          {appFilters.map((item) => (
            <div
              key={item.label}
              className="flex h-[58px] flex-col items-center justify-center gap-[5px] rounded-[11px] border border-[#E5E8ED] bg-white text-[10px] text-[#767C87] shadow-[0_1px_2px_rgba(16,24,40,0.025)]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                className="h-[17px] w-[17px] text-[#767C87]"
                aria-hidden
              >
                {item.icon}
              </svg>
              {item.label}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-auto border-t border-[#E8EAEE] pt-3 text-[9.5px] text-ink-faint">
        All Files · Word, PowerPoint, Excel
      </div>
    </aside>
  );
}
