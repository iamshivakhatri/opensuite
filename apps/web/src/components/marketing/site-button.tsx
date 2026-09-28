import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Public-site buttons.
 *
 * - `solid` — primary brand fill for important CTAs
 * - `outline` — secondary chrome (borders / quieter actions)
 * - `ghost` — text-weight tertiary links that sit in running chrome
 */
type Variant = "solid" | "outline" | "ghost";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] font-medium transition-colors";

const variants: Record<Variant, string> = {
  solid: "bg-primary text-paper hover:bg-primary-hover",
  outline:
    "border border-secondary-line text-secondary hover:border-secondary hover:bg-secondary-soft hover:text-ink",
  ghost:
    "text-ink-soft hover:text-primary",
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
