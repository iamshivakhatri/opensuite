const navItems = [
  { icon: "▦", label: "All Files", active: true },
  { icon: "◷", label: "Recent" },
  { icon: "☆", label: "Starred" },
  { icon: "⌘", label: "Shared" },
];

const appFilters = ["Write", "Slides", "Sheets"];

/**
 * Static visual placeholder for the workspace sidebar from
 * opensuite_v4_modern_minimal.html. Intentionally non-interactive — file
 * browsing is a future milestone, this milestone only proves the
 * authenticated shell renders.
 */
export function Sidebar() {
  return (
    <aside className="flex w-[236px] shrink-0 flex-col gap-5 border-r border-line bg-[#F8F9FB] px-2.5 py-4">
      <div>
        <div className="mb-1.5 px-2 text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          Workspace
        </div>
        <div className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <div
              key={item.label}
              className={
                "flex items-center gap-2 rounded-[9px] px-2 py-2 text-[12px] " +
                (item.active
                  ? "bg-accent-soft font-semibold text-accent"
                  : "text-[#666C77]")
              }
            >
              <span className="w-4 text-center text-[13px] text-[#959AA5]">
                {item.icon}
              </span>
              {item.label}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 px-2 text-[9px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          Apps
        </div>
        <div className="grid grid-cols-3 gap-1.5 px-0.5">
          {appFilters.map((label) => (
            <div
              key={label}
              className="flex h-[58px] flex-col items-center justify-center gap-1 rounded-[11px] border border-[#E5E8ED] bg-white text-[10px] text-[#767C87]"
            >
              {label}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-auto border-t border-[#E8EAEE] pt-3 text-[9.5px] text-ink-faint">
        OpenSuite workspace shell — file browsing coming soon.
      </div>
    </aside>
  );
}
