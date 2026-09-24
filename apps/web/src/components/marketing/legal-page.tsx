import type { ReactNode } from "react";

import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="os-theme-dark min-h-screen bg-paper text-ink">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-5 py-16 sm:px-8 sm:py-20">
        <h1 className="text-[30px] font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h1>
        <p className="mt-2 text-[13px] text-ink-faint">
          Last updated {updated}
        </p>
        <div className="mt-10 space-y-9 text-[15px] leading-relaxed text-ink-soft [&_h2]:mb-2.5 [&_h2]:mt-9 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-ink [&_li]:leading-relaxed [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
          {children}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
