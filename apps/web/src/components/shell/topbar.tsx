"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { signOut } from "@/lib/auth-client";
import { Wordmark } from "@/components/wordmark";
import { Button } from "@/components/ui/button";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Topbar({ userName }: { userName: string }) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = React.useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    await signOut();
    router.push("/sign-in");
  }

  return (
    <header className="flex h-[58px] items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur-xl">
      <Link href="/app" className="shrink-0">
        <Wordmark />
      </Link>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <Link
          href="/app/settings"
          className="grid h-[30px] w-[30px] place-items-center rounded-full text-[10px] font-semibold text-white shadow-[0_0_0_2px_var(--surface),0_2px_8px_rgba(91,92,226,0.16)]"
          style={{
            background: "linear-gradient(145deg, #5E60E8, #8788F5)",
          }}
          title={`${userName} · Settings`}
        >
          {initials(userName)}
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleSignOut()}
          disabled={isSigningOut}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </header>
  );
}
