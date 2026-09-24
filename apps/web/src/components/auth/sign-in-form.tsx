"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { authClient, signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-5"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.72 1.22 9.22 3.61l6.88-6.88C35.93 2.36 30.35 0 24 0 14.62 0 6.51 5.38 2.56 13.22l8.01 6.22C12.48 13.47 17.77 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.1 24.55c0-1.64-.15-3.22-.42-4.73H24v9.03h12.39c-.53 2.87-2.15 5.3-4.58 6.93l7.42 5.76C43.57 37.54 46.1 31.57 46.1 24.55Z" />
      <path fill="#FBBC05" d="M10.57 28.56A14.42 14.42 0 0 1 9.8 24c0-1.58.27-3.12.77-4.56l-8.01-6.22A24 24 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l8.01-6.22Z" />
      <path fill="#34A853" d="M24 48c6.35 0 11.68-2.1 15.57-5.7l-7.42-5.76c-2.1 1.41-4.78 2.25-8.15 2.25-6.23 0-11.52-3.97-13.43-9.57l-8.01 6.22C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isUnverified, setIsUnverified] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = React.useState(false);
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

  async function handleGoogleSignIn() {
    setError(null);
    setIsGoogleSubmitting(true);

    try {
      await signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/app`,
      });
    } catch {
      setError("Could not start Google sign-in. Try again in a moment.");
      setIsGoogleSubmitting(false);
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
      <div className="flex items-center gap-3 text-[11.5px] text-ink-faint">
        <span className="h-px flex-1 bg-line" />
        <span>or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => void handleGoogleSignIn()}
        disabled={isSubmitting || isGoogleSubmitting}
      >
        <GoogleMark />
        {isGoogleSubmitting ? "Opening Google…" : "Continue with Google"}
      </Button>
    </form>
  );
}
