"use client";

import * as React from "react";
import Link from "next/link";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="os-display text-[27px] leading-[1.15]">
          Reset password
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-[1.6] text-ink-soft">
          Choose a new password for your OpenSuite account.
        </p>
      </div>
      <React.Suspense fallback={null}>
        <ResetPasswordForm />
      </React.Suspense>
      <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
        <Link
          href="/sign-in"
          className="font-medium text-primary underline decoration-1 underline-offset-[3px] hover:text-primary-hover"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
