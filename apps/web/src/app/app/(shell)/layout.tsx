"use client";

import * as React from "react";

import { useSession } from "@/lib/auth-client";
import { Topbar } from "@/components/shell/topbar";
import { Sidebar } from "@/components/shell/sidebar";

/**
 * Standard OpenSuite application chrome (topbar + sidebar) for the "All
 * Files" surface and future non-document-workspace routes. The dedicated
 * document workspace lives outside this route group and supplies its own
 * chrome instead.
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
        <main className="min-w-0 flex-1 overflow-auto bg-[#F4F5F7]">
          {children}
        </main>
      </div>
    </div>
  );
}
