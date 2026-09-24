import Link from "next/link";

import { Wordmark } from "@/components/wordmark";
import { GITHUB_URL } from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

const navLinks = [
  { href: "/#product", label: "Product" },
  { href: "/privacy", label: "Privacy" },
  { href: "/#open-source", label: "Open source" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5 sm:px-8">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden flex-1 items-center gap-6 pl-6 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13px] text-ink-soft transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex-1 md:hidden" />

        <div className="flex items-center gap-2.5 sm:gap-3">
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hidden items-center gap-1.5 text-[13px] text-ink-soft transition-colors hover:text-ink sm:flex"
          >
            <GitHubMark className="h-4 w-4" />
            GitHub
          </Link>
          <Link
            href="/sign-in"
            className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          {isSignupAllowed() ? (
            <Link
              href="/sign-up"
              className="rounded-[var(--radius-sm)] bg-primary px-3.5 py-1.5 text-[13px] font-medium text-on-ink transition-colors hover:bg-primary-hover"
            >
              Get started
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.5c-2.22.48-2.7-1.07-2.7-1.07-.36-.93-.88-1.17-.88-1.17-.72-.5.06-.49.06-.49.8.06 1.22.82 1.22.82.71 1.22 1.86.87 2.32.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.58.82-2.14-.08-.2-.36-1.02.08-2.13 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.27.82 2.14 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z" />
    </svg>
  );
}
