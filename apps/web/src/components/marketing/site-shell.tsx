import type { ReactNode } from "react";

import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { siteSerif } from "@/lib/site-fonts";
import { cn } from "@/lib/utils";

/**
 * Root wrapper for every public page with site chrome (`/`, `/privacy`,
 * `/terms`, 404). Owns the paper theme class and the display serif variable
 * so individual pages only describe content.
 */
export function SiteShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "os-site flex min-h-screen flex-col overflow-x-hidden",
        siteSerif.variable,
        className,
      )}
    >
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
