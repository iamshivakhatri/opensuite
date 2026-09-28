"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/lib/auth-client";

/**
 * `/` is public and renders immediately; a signed-in visitor is moved into
 * the workspace afterwards. Keeping the check in a null-rendering client
 * component means the landing page no longer waits behind a loading screen.
 */
export function RedirectSignedIn() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  React.useEffect(() => {
    if (isPending) return;
    if (session) router.replace("/app");
  }, [isPending, session, router]);

  return null;
}
