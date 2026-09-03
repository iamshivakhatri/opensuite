"use client";

import * as React from "react";
import Link from "next/link";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
          Reset password
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          Choose a new password for your OpenSuite account.
        </p>
      </div>
      <React.Suspense fallback={null}>
        <ResetPasswordForm />
      </React.Suspense>
      <p className="text-center text-[12px] text-ink-soft">
        <Link href="/sign-in" className="font-medium text-accent">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
