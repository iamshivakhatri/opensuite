import Link from "next/link";

import { GitHubMark } from "@/components/marketing/github-mark";
import { SiteButton } from "@/components/marketing/site-button";
import { SiteWordmark } from "@/components/marketing/site-wordmark";
import { GITHUB_URL } from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

const navLinks = [
  { href: "/#workspace", label: "Product" },
  { href: "/#run", label: "How it works" },
  { href: "/#open-source", label: "Open source" },
];

export function SiteHeader() {
  const startHref = isSignupAllowed() ? "/sign-up" : "/sign-in";

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur-[6px]">
      <div className="os-container flex h-16 items-center gap-8 sm:h-[72px]">
        <Link
          href="/"
          className="shrink-0 rounded-[3px]"
          aria-label="OpenSuite home"
        >
          <SiteWordmark />
        </Link>

        <nav
          aria-label="Site"
          className="hidden flex-1 items-center gap-7 md:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13.5px] text-ink-soft transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex-1 md:hidden" />

        <div className="flex items-center gap-1">
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-9 items-center gap-2 rounded-[3px] px-2 text-[13.5px] text-ink-soft transition-colors hover:text-ink"
          >
            <GitHubMark className="h-[15px] w-[15px]" />
            <span className="hidden sm:inline">GitHub</span>
            <span className="sr-only sm:hidden">GitHub repository</span>
          </Link>
          <span className="mx-2 hidden h-5 w-px bg-line sm:block" />
          <Link
            href="/sign-in"
            className="flex h-9 items-center rounded-[3px] px-2 text-[13.5px] text-ink-soft transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          {isSignupAllowed() ? (
            <SiteButton href={startHref} size="sm" className="ml-1.5">
              Try OpenSuite
            </SiteButton>
          ) : null}
        </div>
      </div>
    </header>
  );
}
