"use client";

import * as React from "react";

import { useSession } from "@/lib/auth-client";
import { Topbar } from "@/components/shell/topbar";
import { Sidebar } from "@/components/shell/sidebar";

/**
 * Standard OpenSuite application chrome (topbar + sidebar) for library
 * surfaces. The dedicated workspace IDE lives outside this route group.
 */
export default function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session } = useSession();

  if (!session) {
    return null;
  }

  return (
    <div className="grid h-screen grid-rows-[58px_1fr]">
      <Topbar userName={session.user.name} />
      <div className="flex min-h-0">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto bg-[var(--shell-main)]">
          {children}
        </main>
      </div>
    </div>
  );
}
