import type { Metadata } from "next";
import Link from "next/link";

import { GitHubMark } from "@/components/marketing/github-mark";
import { SiteButton } from "@/components/marketing/site-button";
import { SiteShell } from "@/components/marketing/site-shell";
import { GITHUB_URL } from "@/lib/site";
import { SITE_PRIMARY_NAV } from "@/lib/site-nav";

export const metadata: Metadata = {
  title: "Page not found — OpenSuite",
};

const elsewhere = [
  ...SITE_PRIMARY_NAV.map((link) => ({
    href: link.href,
    label: link.label,
  })),
  { href: "/sign-in", label: "Sign in" },
  { href: "/privacy", label: "Privacy" },
];

export default function NotFound() {
  return (
    <SiteShell>
      <div className="os-container py-24 sm:py-32">
        <p className="os-label">
          <span className="text-primary">404</span>
          <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
            /
          </span>
          Not found
        </p>
        <h1 className="os-display mt-5 max-w-[20ch] text-[32px] leading-[1.1] sm:text-[42px]">
          This page isn&apos;t here.
        </h1>
        <p className="os-lead mt-5 max-w-[46ch]">
          The link may be out of date, or the page may have moved while
          OpenSuite was being built.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <SiteButton href="/">Back to home</SiteButton>
          <SiteButton href={GITHUB_URL} variant="outline" external>
            <GitHubMark className="h-4 w-4" />
            GitHub
          </SiteButton>
        </div>

        <div className="mt-16 max-w-[26rem]">
          <h2 className="os-label">Elsewhere</h2>
          <ul className="mt-4 border-t border-line">
            {elsewhere.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex items-baseline justify-between gap-4 border-b border-line py-3.5 text-[14.5px] text-ink-soft transition-colors hover:text-primary"
                >
                  {link.label}
                  <span aria-hidden="true" className="os-annot text-secondary">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SiteShell>
  );
}
