"use client";

import * as React from "react";
import Link from "next/link";

import { authClient } from "@/lib/auth-client";
import {
  AuthField,
  AuthNotice,
  AuthSubmit,
} from "@/components/auth/auth-primitives";

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
      <div className="flex flex-col gap-4">
        <p className="os-label">Check your email</p>
        <p className="text-[14.5px] leading-[1.65] text-ink-soft">
          If an account exists for{" "}
          <span className="font-medium text-ink">{email}</span>, we sent a
          password reset link. It expires in one hour.
        </p>
        <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
          <Link
            href="/sign-in"
            className="font-medium text-link underline decoration-1 underline-offset-[3px] hover:text-link-hover"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <AuthField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <AuthSubmit type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Sending…" : "Send reset link"}
      </AuthSubmit>
    </form>
  );
}
