"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

export default function RootPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (isPending) return;
    if (session) {
      router.replace("/app");
      return;
    }
    // Debounce unauthenticated redirect so a slow session hydrate does not
    // flash the sign-in page for logged-in users.
    const timer = window.setTimeout(() => {
      router.replace("/sign-in");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isPending, session, router]);

  return (
    <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
      Loading OpenSuite…
    </div>
  );
}
