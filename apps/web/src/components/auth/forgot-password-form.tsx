"use client";

import * as React from "react";
import Link from "next/link";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const { error: resetError } = await authClient.requestPasswordReset({
        email,
        // Absolute URL required: Better Auth validates redirectTo against
        // trustedOrigins, then redirects here with ?token=… or ?error=….
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (resetError) {
        setError("Could not send a reset email. Try again in a moment.");
        return;
      }

      // Always show the same success state — Better Auth does not reveal
      // whether the email exists.
      setSubmitted(true);
    } catch {
      setError("Could not reach the OpenSuite API. Check your connection.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-[12px] bg-accent-soft text-accent">
          ✉
        </div>
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
            Check your email
          </h1>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
            If an account exists for{" "}
            <span className="font-medium text-ink">{email}</span>, we sent a
            password reset link. It expires in 1 hour.
          </p>
        </div>
        <p className="text-center text-[12px] text-ink-soft">
          <Link href="/sign-in" className="font-medium text-accent">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {error ? (
        <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="accent" disabled={isSubmitting}>
        {isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
