"use client";

import * as React from "react";
import Link from "next/link";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { CheckEmailNotice } from "@/components/auth/check-email-notice";
import { isSignupAllowed } from "@/lib/signup";

export default function SignUpPage() {
  const [submittedEmail, setSubmittedEmail] = React.useState<string | null>(
    null,
  );

  if (!isSignupAllowed()) {
    return (
      <div className="flex flex-col gap-7">
        <div>
          <h1 className="os-display text-[27px] leading-[1.15]">
            Sign-up is closed
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-[1.6] text-ink-soft">
            New accounts are not being accepted right now.
          </p>
        </div>
        <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="font-medium text-link underline decoration-1 underline-offset-[3px] hover:text-link-hover"
          >
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  if (submittedEmail) {
    return <CheckEmailNotice email={submittedEmail} />;
  }

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="os-display text-[27px] leading-[1.15]">
          Create your account
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-[1.6] text-ink-soft">
          Email verification is required before the first sign-in.
        </p>
      </div>
      <SignUpForm onSignedUp={setSubmittedEmail} />
      <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-link underline decoration-1 underline-offset-[3px] hover:text-link-hover"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
