"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

/**
 * Auth routes must not render the sign-in/up UI when a session is already
 * active — redirect straight into the app instead.
 */
export function RedirectIfAuthenticated({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (!isPending && session) {
      router.replace("/app");
    }
  }, [isPending, session, router]);

  if (isPending) {
    return (
      <div className="py-8 text-center text-[13px] text-ink-soft">
        Loading…
      </div>
    );
  }

  if (session) {
    return (
      <div className="py-8 text-center text-[13px] text-ink-soft">
        Redirecting…
      </div>
    );
  }

  return children;
}
