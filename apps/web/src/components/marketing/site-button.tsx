import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The only two button treatments on the public site.
 *
 * `solid` is ink, not accent: the brick accent stays reserved for editorial
 * marks, links, and the edited line in the product visual, so buttons never
 * turn the page into a row of coloured pills.
 */
type Variant = "solid" | "outline";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] font-medium transition-colors";

const variants: Record<Variant, string> = {
  solid: "bg-ink text-paper hover:bg-[#2c2c28]",
  outline:
    "border border-[var(--rule)] text-ink-soft hover:border-ink hover:text-ink",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13.5px]",
  md: "h-11 px-5 text-[14.5px]",
};

export function siteButtonClass(
  variant: Variant = "solid",
  size: Size = "md",
  className?: string,
) {
  return cn(base, variants[variant], sizes[size], className);
}

export function SiteButton({
  href,
  variant = "solid",
  size = "md",
  external,
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  external?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      {...(external
        ? { target: "_blank", rel: "noreferrer noopener" }
        : null)}
      className={siteButtonClass(variant, size, className)}
    >
      {children}
    </Link>
  );
}
