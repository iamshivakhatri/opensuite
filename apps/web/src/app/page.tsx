"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

export default function RootPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (isPending) return;
    router.replace(session ? "/app" : "/sign-in");
  }, [isPending, session, router]);

  return (
    <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
      Loading OpenSuite…
    </div>
  );
}
