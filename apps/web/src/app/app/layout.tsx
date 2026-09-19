"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import {
  isDatabaseUnavailable,
  useServiceStatus,
} from "@/lib/service-status";

/**
 * Auth gate shared by every `/app/*` route. Restores the session on load via
 * Better Auth's `useSession` and redirects unauthenticated visitors to
 * `/sign-in`. Deliberately holds no chrome (topbar/sidebar) — library
 * surfaces and the workspace IDE render different chrome, so each owns its
 * own layout beneath this gate.
 *
 * Stay on the loading screen until the session check settles. A short debounce
 * avoids bouncing logged-in users to `/sign-in` during session hydration races.
 * Database/API outages use the calm top banner — do not replace the whole app.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending, error: sessionError } = useSession();
  const serviceStatus = useServiceStatus();
  const databaseDown = isDatabaseUnavailable(serviceStatus);

  React.useEffect(() => {
    if (isPending || session || databaseDown || sessionError) {
      return;
    }
    const timer = window.setTimeout(() => {
      router.replace("/sign-in");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isPending, session, databaseDown, sessionError, router]);

  // Keep the shell when we still have a session; outage UX is the banner +
  // per-operation errors, not a full-screen takeover.
  if (session) {
    return (
      <CommandPaletteProvider>
        <div className="h-screen">{children}</div>
      </CommandPaletteProvider>
    );
  }

  if (isPending) {
    return (
      <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
        Loading OpenSuite…
      </div>
    );
  }

  // No session and DB/API down — hold calmly (don't force sign-out thrash).
  if (databaseDown) {
    return (
      <div className="grid h-screen place-items-center px-6 text-center">
        <div className="max-w-sm space-y-1.5">
          <p className="text-[length:var(--text-sm)] font-medium text-ink">
            No connection with the database
          </p>
          <p className="os-type-secondary text-ink-faint">
            OpenSuite will reconnect automatically. You can keep this tab open.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
      Loading OpenSuite…
    </div>
  );
}
