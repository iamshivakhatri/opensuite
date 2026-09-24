"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { LandingPage } from "@/components/marketing/landing-page";
import { useSession } from "@/lib/auth-client";

export default function RootPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (isPending) return;
    if (session) {
      router.replace("/app");
    }
    // No unauthenticated redirect — `/` is the public landing page.
  }, [isPending, session, router]);

  if (isPending || session) {
    return (
      <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
        Loading OpenSuite…
      </div>
    );
  }

  return <LandingPage />;
}
