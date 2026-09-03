"use client";

import * as React from "react";
import Link from "next/link";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { CheckEmailNotice } from "@/components/auth/check-email-notice";

export default function SignUpPage() {
  const [submittedEmail, setSubmittedEmail] = React.useState<string | null>(
    null,
  );

  if (submittedEmail) {
    return <CheckEmailNotice email={submittedEmail} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
          Create your account
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          Start using OpenSuite.
        </p>
      </div>
      <SignUpForm onSignedUp={setSubmittedEmail} />
      <p className="text-center text-[12px] text-ink-soft">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-accent">
          Sign in
        </Link>
      </p>
    </div>
  );
}
