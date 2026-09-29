import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/** Public chrome wordmark — same mark as the favicon / app shell. */
export function SiteWordmark({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 text-[15.5px] font-semibold tracking-[-0.028em] text-ink",
        className,
      )}
    >
      <BrandMark className={cn("h-[19px] w-[19px]", markClassName)} />
      OpenSuite
    </span>
  );
}
