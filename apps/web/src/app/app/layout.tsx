"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";
import { Topbar } from "@/components/shell/topbar";
import { Sidebar } from "@/components/shell/sidebar";

/**
 * Gate for the authenticated OpenSuite shell. Restores the session on load
 * via Better Auth's `useSession`, redirects unauthenticated visitors to
 * `/sign-in`, and otherwise renders the app frame (topbar + sidebar) around
 * whatever the child route renders.
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

  return (
    <div className="grid h-screen grid-rows-[58px_1fr]">
      <Topbar userName={session.user.name} />
      <div className="flex min-h-0">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto bg-[#F4F5F7]">
          {children}
        </main>
      </div>
    </div>
  );
}
