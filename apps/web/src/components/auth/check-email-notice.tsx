"use client";

import * as React from "react";

import { authClient } from "@/lib/auth-client";
import { AuthSecondaryButton } from "@/components/auth/auth-primitives";

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
    <div className="flex flex-col gap-6">
      <div>
        <p className="os-label">One step left</p>
        <h1 className="os-display mt-4 text-[27px] leading-[1.15]">
          Check your email
        </h1>
        <p className="mt-3 text-[14.5px] leading-[1.65] text-ink-soft">
          We sent a verification link to{" "}
          <span className="font-medium text-ink">{email}</span>. Open it to
          finish setting up your account, then sign in.
        </p>
      </div>
      <div className="flex flex-col gap-2.5 border-t border-line pt-5">
        <AuthSecondaryButton
          type="button"
          onClick={() => void handleResend()}
          disabled={resendState === "sending"}
        >
          {resendState === "sending" ? "Sending…" : "Resend verification email"}
        </AuthSecondaryButton>
        {resendState === "sent" ? (
          <p className="text-[13px] text-success">Verification email sent.</p>
        ) : null}
        {resendState === "error" ? (
          <p className="text-[13px] text-danger">
            Could not resend the email. Try again in a moment.
          </p>
        ) : null}
      </div>
    </div>
  );
}
