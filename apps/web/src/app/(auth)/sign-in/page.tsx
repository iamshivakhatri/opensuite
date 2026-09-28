"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { SignInForm } from "@/components/auth/sign-in-form";
import { isSignupAllowed } from "@/lib/signup";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "That verification link is invalid. Request a new one below.",
  TOKEN_EXPIRED: "That verification link has expired. Request a new one below.",
  USER_NOT_FOUND: "We couldn't find an account for that verification link.",
  account_not_linked:
    "This email already has an unverified OpenSuite account. Verify it first, then continue with Google.",
};

function AuthBanner() {
  const searchParams = useSearchParams();
  const verified = searchParams.get("verified") === "true";
  const reset = searchParams.get("reset") === "true";
  const errorCode = searchParams.get("error");

  if (verified) {
    return (
      <p className="border-l-2 border-success bg-success-soft px-4 py-3 text-[13.5px] leading-[1.55] text-success">
        Your email is verified. Sign in below.
      </p>
    );
  }

  if (reset) {
    return (
      <p className="border-l-2 border-success bg-success-soft px-4 py-3 text-[13.5px] leading-[1.55] text-success">
        Your password was updated. Sign in with your new password.
      </p>
    );
  }

  if (errorCode) {
    return (
      <p className="border-l-2 border-danger bg-danger-soft px-4 py-3 text-[13.5px] leading-[1.55] text-danger">
        {AUTH_ERROR_MESSAGES[errorCode] ??
          "That verification link could not be used. Request a new one below."}
      </p>
    );
  }

  return null;
}

export default function SignInPage() {
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="os-display text-[27px] leading-[1.15]">Sign in</h1>
        <p className="mt-2.5 text-[14.5px] leading-[1.6] text-ink-soft">
          Continue to your workspace.
        </p>
      </div>
      <React.Suspense fallback={null}>
        <AuthBanner />
      </React.Suspense>
      <SignInForm />
      {isSignupAllowed() ? (
        <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
          No account yet?{" "}
          <Link
            href="/sign-up"
            className="font-medium text-primary underline decoration-1 underline-offset-[3px] hover:text-primary-hover"
          >
            Create one
          </Link>
        </p>
      ) : null}
    </div>
  );
}
