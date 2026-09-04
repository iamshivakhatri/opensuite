"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

/**
 * Auth gate shared by every `/app/*` route. Restores the session on load via
 * Better Auth's `useSession` and redirects unauthenticated visitors to
 * `/sign-in`. Deliberately holds no chrome (topbar/sidebar) — the "All
 * Files" surface and the dedicated document workspace render different
 * chrome, so each owns its own layout beneath this gate.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (!isPending && !session) {
      router.replace("/sign-in");
    }
  }, [isPending, session, router]);

  if (isPending) {
    return (
      <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
        Loading OpenSuite…
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return <div className="h-screen">{children}</div>;
}
