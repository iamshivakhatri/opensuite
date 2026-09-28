"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "@/lib/auth-client";
import {
  AuthField,
  AuthNotice,
  AuthSubmit,
} from "@/components/auth/auth-primitives";

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const linkError = searchParams.get("error");

  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  if (linkError || !token) {
    return (
      <div className="flex flex-col gap-5">
        <AuthNotice>
          {linkError
            ? "That password reset link is invalid or has expired."
            : "This page needs a valid password reset link from your email."}
        </AuthNotice>
        <p className="text-[13.5px] text-ink-soft">
          <Link
            href="/forgot-password"
            className="font-medium text-link underline decoration-1 underline-offset-[3px] hover:text-link-hover"
          >
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);

    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token: token!,
      });

      if (resetError) {
        setError(
          resetError.code === "INVALID_TOKEN"
            ? "That password reset link is invalid or has expired."
            : "Could not reset your password. Try again in a moment.",
        );
        return;
      }

      // Better Auth does not create a session on password reset — send the
      // user to sign in with the new password.
      router.push("/sign-in?reset=true");
    } catch {
      setError("Could not reach the OpenSuite API. Check your connection.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <AuthField
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={<span className="text-[12px] text-ink-faint">8+ characters</span>}
      />
      <AuthField
        id="confirmPassword"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
      />
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <AuthSubmit type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Updating…" : "Update password"}
      </AuthSubmit>
    </form>
  );
}
