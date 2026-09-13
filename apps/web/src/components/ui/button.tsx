import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] text-[length:var(--text-sm)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    focusRingClass,
  ),
  {
    variants: {
      variant: {
        primary: "bg-primary text-on-ink hover:bg-primary-hover",
        /** Alias of primary — prefer `primary` for new CTAs. */
        accent: "bg-primary text-on-ink hover:bg-primary-hover",
        /** Quiet theme chrome — border/hover only, no full fill. */
        secondary:
          "border border-secondary-line bg-surface text-ink-soft hover:border-primary-line hover:bg-primary-soft hover:text-primary",
        outline:
          "border border-line bg-surface text-ink-soft hover:border-primary-line hover:bg-primary-soft hover:text-primary",
        ghost: "text-ink-soft hover:bg-primary-soft hover:text-primary",
      },
      size: {
        default: "h-9 px-4",
        /** Keep the shared readable scale — do not drop to Tailwind text-xs. */
        sm: "h-8 px-3",
        /** Square icon-only button — see docs/future/frontend-audit.md Section R. */
        icon: "h-7 w-7 rounded-[var(--radius-md)] p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
