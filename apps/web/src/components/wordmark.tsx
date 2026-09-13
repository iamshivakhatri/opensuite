import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[16px] font-semibold tracking-[-0.025em] text-ink",
        className,
      )}
    >
      <span
        aria-hidden
        className="relative block h-[18px] w-[18px] rounded-[6px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_4px_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
        style={{
          background:
            "linear-gradient(145deg, color-mix(in srgb, var(--primary) 70%, white), var(--primary-hover))",
        }}
      >
        <span className="absolute left-[6.5px] top-[6.5px] h-[5px] w-[5px] rounded-[2px] bg-white opacity-90" />
      </span>
      OpenSuite
    </div>
  );
}
