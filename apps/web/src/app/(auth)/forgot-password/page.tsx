import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
          Forgot password
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          Enter your email and we&apos;ll send a reset link if an account
          exists.
        </p>
      </div>
      <ForgotPasswordForm />
      <p className="text-center text-[12px] text-ink-soft">
        Remembered it?{" "}
        <Link href="/sign-in" className="font-medium text-accent">
          Sign in
        </Link>
      </p>
    </div>
  );
}
