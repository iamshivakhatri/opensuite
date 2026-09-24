import Link from "next/link";

import { Wordmark } from "@/components/wordmark";
import { GITHUB_URL, SUPPORT_EMAIL } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-line/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Wordmark />
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-soft">
          <Link href="/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-ink"
          >
            GitHub
          </Link>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-ink">
            Contact
          </a>
          <Link href="/sign-in" className="hover:text-ink">
            Sign in
          </Link>
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-10 text-[12px] text-ink-faint sm:px-8">
        © {new Date().getFullYear()} OpenSuite. Open-source software,
        distributed as-is.
      </div>
    </footer>
  );
}
