"use client";

import * as React from "react";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function CheckEmailNotice({ email }: { email: string }) {
  const [resendState, setResendState] = React.useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");

  async function handleResend() {
    setResendState("sending");

    const { error } = await authClient.sendVerificationEmail({
      email,
      // Must be an absolute URL: Better Auth redirects here verbatim after
      // verification, and its originCheck requires it to match WEB_ORIGIN.
      callbackURL: `${window.location.origin}/sign-in?verified=true`,
    });

    setResendState(error ? "error" : "sent");
  }

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
          We sent a verification link to{" "}
          <span className="font-medium text-ink">{email}</span>. Click it to
          finish setting up your account, then sign in.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handleResend()}
        disabled={resendState === "sending"}
      >
        {resendState === "sending" ? "Sending…" : "Resend verification email"}
      </Button>
      {resendState === "sent" ? (
        <p className="text-[12px] text-success">Verification email sent.</p>
      ) : null}
      {resendState === "error" ? (
        <p className="text-[12px] text-danger">
          Could not resend the email. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
