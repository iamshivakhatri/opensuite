"use client";

import * as React from "react";

import { signUp } from "@/lib/auth-client";
import {
  AuthField,
  AuthNotice,
  AuthSubmit,
} from "@/components/auth/auth-primitives";

export function SignUpForm({
  onSignedUp,
}: {
  onSignedUp: (email: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const { error: signUpError } = await signUp.email({
      name,
      email,
      password,
      // Must be an absolute URL: Better Auth redirects here verbatim after
      // verification, and its originCheck requires it to match WEB_ORIGIN.
      callbackURL: `${window.location.origin}/sign-in?verified=true`,
    });

    setIsSubmitting(false);

    if (signUpError) {
      setError(signUpError.message ?? "Could not create an account.");
      return;
    }

    // Sign-up never returns a session (email verification is required), so
    // there's nothing to redirect into yet — show the "check your email"
    // state instead.
    onSignedUp(email);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <AuthField
        id="name"
        label="Name"
        type="text"
        autoComplete="name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <AuthField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <AuthField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={<span className="text-[12px] text-ink-faint">8+ characters</span>}
      />
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <AuthSubmit type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating account…" : "Create account"}
      </AuthSubmit>
    </form>
  );
}
