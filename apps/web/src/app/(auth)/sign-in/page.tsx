"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { SignInForm } from "@/components/auth/sign-in-form";

const VERIFICATION_ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "That verification link is invalid. Request a new one below.",
  TOKEN_EXPIRED: "That verification link has expired. Request a new one below.",
  USER_NOT_FOUND: "We couldn't find an account for that verification link.",
};

function AuthBanner() {
  const searchParams = useSearchParams();
  const verified = searchParams.get("verified") === "true";
  const reset = searchParams.get("reset") === "true";
  const errorCode = searchParams.get("error");

  if (verified) {
    return (
      <p className="rounded-[var(--radius-sm)] bg-success-soft px-3 py-2 text-[12px] text-success">
        Your email is verified. Sign in below.
      </p>
    );
  }

  if (reset) {
    return (
      <p className="rounded-[var(--radius-sm)] bg-success-soft px-3 py-2 text-[12px] text-success">
        Your password was updated. Sign in with your new password.
      </p>
    );
  }

  if (errorCode) {
    return (
      <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
        {VERIFICATION_ERROR_MESSAGES[errorCode] ??
          "That verification link could not be used. Request a new one below."}
      </p>
    );
  }

  return null;
}

export default function SignInPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
          Sign in
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          Welcome back to OpenSuite.
        </p>
      </div>
      <React.Suspense fallback={null}>
        <AuthBanner />
      </React.Suspense>
      <SignInForm />
      <p className="text-center text-[12px] text-ink-soft">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="font-medium text-accent">
          Sign up
        </Link>
      </p>
    </div>
  );
}
