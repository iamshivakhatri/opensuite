import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[16px] font-semibold tracking-[-0.025em] text-ink",
        className,
      )}
    >
      <BrandMark className="h-[18px] w-[18px]" />
      OpenSuite
    </div>
  );
}
