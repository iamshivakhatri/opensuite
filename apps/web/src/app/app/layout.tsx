"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";
import { CommandPaletteProvider } from "@/components/shell/command-palette";

/**
 * Auth gate shared by every `/app/*` route. Restores the session on load via
 * Better Auth's `useSession` and redirects unauthenticated visitors to
 * `/sign-in`. Deliberately holds no chrome (topbar/sidebar) — library
 * surfaces and the workspace IDE render different chrome, so each owns its
 * own layout beneath this gate.
 *
 * Stay on the loading screen until the session check settles. A short debounce
 * avoids bouncing logged-in users to `/sign-in` during session hydration races.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (isPending || session) {
      return;
    }
    const timer = window.setTimeout(() => {
      router.replace("/sign-in");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isPending, session, router]);

  if (isPending || !session) {
    return (
      <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
        Loading OpenSuite…
      </div>
    );
  }

  return (
    <CommandPaletteProvider>
      <div className="h-screen">{children}</div>
    </CommandPaletteProvider>
  );
}
