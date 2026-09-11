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
        primary: "bg-ink text-on-ink hover:opacity-90",
        accent: "bg-accent text-on-ink hover:bg-accent-hover",
        outline:
          "border border-line bg-surface text-ink-soft hover:border-ink-faint hover:text-ink",
        ghost: "text-ink-soft hover:bg-sunken hover:text-ink",
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
