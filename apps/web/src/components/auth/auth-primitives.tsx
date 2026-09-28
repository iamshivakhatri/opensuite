import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Shared field / submit / notice treatment for the four public auth forms.
 *
 * The workspace `ui/` primitives are intentionally dense; auth pages are the
 * first screen someone sees, so they run one step larger and with the public
 * site's ink button instead of the accent fill. Keeping that in one place
 * stops the four forms from drifting apart.
 */
export function AuthField({
  id,
  label,
  hint,
  className,
  ...inputProps
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="text-[12.5px] font-medium text-ink">
          {label}
        </Label>
        {hint}
      </div>
      <Input
        id={id}
        className={cn(
          "h-10 text-[14px] placeholder:text-ink-faint focus-visible:border-ink focus-visible:ring-0",
          className,
        )}
        {...inputProps}
      />
    </div>
  );
}

export function AuthSubmit({ className, ...props }: ButtonProps) {
  return (
    <Button
      className={cn(
        "h-11 w-full bg-primary text-[14.5px] text-paper hover:bg-primary-hover",
        className,
      )}
      {...props}
    />
  );
}

export function AuthSecondaryButton({ className, ...props }: ButtonProps) {
  return (
    <Button
      variant="outline"
      className={cn(
        "h-11 w-full border-secondary-line bg-transparent text-[14.5px] text-secondary hover:border-secondary hover:bg-secondary-soft hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}

/** Inline status message: a rule in the margin, not a rounded pill. */
export function AuthNotice({
  tone = "error",
  children,
}: {
  tone?: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "border-l-2 px-4 py-3 text-[13.5px] leading-[1.55]",
        tone === "error"
          ? "border-danger bg-danger-soft text-danger"
          : "border-success bg-success-soft text-success",
      )}
    >
      {children}
    </p>
  );
}
