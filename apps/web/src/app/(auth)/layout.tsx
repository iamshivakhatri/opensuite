import type { ReactNode } from "react";
import Link from "next/link";

import { RedirectIfAuthenticated } from "@/components/auth/redirect-if-authenticated";
import { GitHubMark } from "@/components/marketing/github-mark";
import { SiteWordmark } from "@/components/marketing/site-wordmark";
import { ServiceStatusBanner } from "@/components/service-status-banner";
import { GITHUB_URL } from "@/lib/site";
import { siteSerif } from "@/lib/site-fonts";
import { ServiceStatusProvider } from "@/lib/service-status";

const facts = [
  {
    label: "Typed operations",
    body: "Changes are named operations a document engine performs, not rewritten files.",
  },
  {
    label: "Immutable versions",
    body: "Each run saves once. Earlier versions of a document stay where they were.",
  },
  {
    label: "MIT licensed",
    body: "The application and the document engine are public. Self-host either one.",
  },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <ServiceStatusProvider>
      <div className={`os-site ${siteSerif.variable}`}>
        {/* Sign-in depends on the API — say so before the form fails. */}
        <ServiceStatusBanner />

        <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* Statement pane — wide screens only. */}
          <aside className="hidden flex-col justify-between gap-16 border-r border-line bg-paper px-12 py-12 lg:flex xl:px-16">
            <Link href="/" className="w-fit rounded-[3px]">
              <SiteWordmark />
            </Link>

            <div className="max-w-[30rem]">
              <p className="os-label">Open source · DOCX · Alpha</p>
              <p className="os-display mt-5 text-[30px] leading-[1.15]">
                The agent works on the real document, not a copy of it.
              </p>
              <dl className="mt-10 border-t border-line">
                {facts.map((fact) => (
                  <div
                    key={fact.label}
                    className="grid gap-1.5 border-b border-line py-4 xl:grid-cols-[9.5rem_minmax(0,1fr)] xl:gap-6"
                  >
                    <dt className="os-label pt-0.5">{fact.label}</dt>
                    <dd className="text-[13.5px] leading-[1.6] text-ink-soft">
                      {fact.body}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <nav
              aria-label="Site"
              className="flex items-center gap-6 text-[12.5px] text-ink-faint"
            >
              <Link href="/" className="transition-colors hover:text-ink">
                Home
              </Link>
              <Link href="/privacy" className="transition-colors hover:text-ink">
                Privacy
              </Link>
              <Link href="/terms" className="transition-colors hover:text-ink">
                Terms
              </Link>
              <Link
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 transition-colors hover:text-ink"
              >
                <GitHubMark className="h-3.5 w-3.5" />
                GitHub
              </Link>
            </nav>
          </aside>

          {/* Form pane. */}
          <div className="flex min-h-screen flex-col bg-surface">
            <div className="flex h-16 items-center justify-between border-b border-line px-5 sm:px-8 lg:hidden">
              <Link href="/" className="rounded-[3px]">
                <SiteWordmark />
              </Link>
              <Link
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="OpenSuite on GitHub"
                className="rounded-[3px] p-1 text-ink-faint transition-colors hover:text-ink"
              >
                <GitHubMark className="h-4 w-4" />
              </Link>
            </div>

            <main className="flex flex-1 items-center px-5 py-14 sm:px-10 sm:py-16 lg:px-16">
              <div className="mx-auto w-full max-w-[25rem]">
                <RedirectIfAuthenticated>{children}</RedirectIfAuthenticated>
              </div>
            </main>

            <div className="px-5 pb-8 sm:px-10 lg:hidden">
              <nav
                aria-label="Legal"
                className="mx-auto flex max-w-[25rem] items-center gap-5 text-[12.5px] text-ink-faint"
              >
                <Link
                  href="/privacy"
                  className="transition-colors hover:text-ink"
                >
                  Privacy
                </Link>
                <Link href="/terms" className="transition-colors hover:text-ink">
                  Terms
                </Link>
              </nav>
            </div>
          </div>
        </div>
      </div>
    </ServiceStatusProvider>
  );
}
