import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="os-display text-[27px] leading-[1.15]">
          Forgot password
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-[1.6] text-ink-soft">
          Enter your email and we&apos;ll send a reset link if an account
          exists.
        </p>
      </div>
      <ForgotPasswordForm />
      <p className="border-t border-line pt-5 text-[13.5px] text-ink-soft">
        Remembered it?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-link underline decoration-1 underline-offset-[3px] hover:text-link-hover"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
