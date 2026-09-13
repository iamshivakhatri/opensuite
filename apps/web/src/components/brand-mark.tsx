"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * OpenSuite mark (rounded square + center pixel).
 * Colors come from CSS brand tokens — change --primary* in globals.css.
 */
export function BrandMark({
  className,
  title,
}: {
  className?: string;
  /** When set, exposes the mark to assistive tech. */
  title?: string;
}) {
  const gradId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={cn(
        "shrink-0 drop-shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]",
        className,
      )}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id={gradId}
          x1="4"
          y1="2"
          x2="28"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="color-mix(in srgb, var(--primary) 70%, white)" />
          <stop offset="1" stopColor="var(--primary-hover)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradId})`} />
      <rect
        x="11"
        y="11"
        width="10"
        height="10"
        rx="2.75"
        fill="#ffffff"
        fillOpacity="0.95"
      />
    </svg>
  );
}
