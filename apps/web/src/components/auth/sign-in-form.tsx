"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { authClient, signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isUnverified, setIsUnverified] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [resendState, setResendState] = React.useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsUnverified(false);
    setResendState("idle");
    setIsSubmitting(true);

    try {
      const { error: signInError } = await signIn.email({ email, password });

      if (signInError) {
        if (signInError.code === "EMAIL_NOT_VERIFIED") {
          setIsUnverified(true);
          setError("Verify your email before signing in.");
        } else {
          setError(signInError.message ?? "Could not sign in.");
        }
        return;
      }

      router.push("/app");
    } catch {
      setError("Could not reach the OpenSuite API. Check your connection.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    setResendState("sending");

    try {
      const { error } = await authClient.sendVerificationEmail({
        email,
        callbackURL: `${window.location.origin}/sign-in?verified=true`,
      });
      setResendState(error ? "error" : "sent");
    } catch {
      setResendState("error");
    }
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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-[11.5px] font-medium text-accent"
          >
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {error ? (
        <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      {isUnverified ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleResend()}
            disabled={resendState === "sending"}
          >
            {resendState === "sending"
              ? "Sending…"
              : "Resend verification email"}
          </Button>
          {resendState === "sent" ? (
            <p className="text-[12px] text-success">
              Verification email sent.
            </p>
          ) : null}
          {resendState === "error" ? (
            <p className="text-[12px] text-danger">
              Could not resend the email. Try again in a moment.
            </p>
          ) : null}
        </div>
      ) : null}
      <Button type="submit" variant="accent" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
